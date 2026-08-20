// telemetry.js - OpenTelemetry traces and metrics, exporting to the console by
// default so this works with no backend, no account and no credit card.
//
// WHY MANUAL INSTRUMENTATION AND NOT `@opentelemetry/auto-instrumentations-node`
//
// Two reasons, and the second is the real one.
//
//   1. This package is ESM ("type": "module"). Auto-instrumentation patches
//      CommonJS `require`, so under ESM it needs a loader hook
//      (`--experimental-loader @opentelemetry/instrumentation/hook.mjs`) wired
//      into every entry point - `npm start`, the Dockerfile, the profiler, the
//      load test. That is four places to forget.
//   2. It would have told us about `http`, `fs` and `dns`. The measured cost of
//      a request here is 78% Tesseract, 4% retrieval and ~0.6% model call
//      against a stub (MEASUREMENTS.md). None of those are library calls an
//      auto-instrumentor knows the names of. The spans worth having are this
//      application's own stages, and they have to be written by hand whichever
//      way the HTTP layer is instrumented.
//
// So the dependency footprint is seven Apache-2.0 packages and no loader hook,
// and every span in the trace is one somebody chose. The cost of that choice is
// stated rather than hidden: there is no automatic span for an outbound HTTP
// call, so the Groq round trip is timed by the `llm.generate` span written
// around it and nothing else.
//
// CONFIGURATION (the names are OpenTelemetry's own, not invented here)
//
//   OTEL_SERVICE_NAME             defaults to smart-ingredient-analyzer
//   OTEL_TRACES_EXPORTER          console (default) | otlp | none
//   OTEL_METRICS_EXPORTER         console (default) | otlp | none
//   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. http://localhost:4318 - setting this
//                                 switches both exporters to otlp unless they
//                                 were named explicitly
//   OTEL_METRIC_EXPORT_INTERVAL   milliseconds between metric exports (60000)
//
// Under NODE_ENV=test everything defaults to `none`, so the unit tests do not
// print a span apiece.
import { trace, metrics, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider, BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "smart-ingredient-analyzer";

function chosenExporter(variable) {
  const explicit = process.env[variable]?.trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "test") return "none";
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return "otlp";
  return "console";
}

let providers = null;

/**
 * Start the SDK. Returns a shutdown function, which the server's SIGTERM
 * handler calls so a batch of spans is not lost on a deploy.
 *
 * Safe to skip entirely: every span and metric in this file goes through the
 * `@opentelemetry/api` facade, which is a no-op implementation until something
 * registers a real provider. Nothing else in the codebase branches on whether
 * telemetry is on.
 */
export async function startTelemetry() {
  if (providers) return providers.shutdown;

  const traces = chosenExporter("OTEL_TRACES_EXPORTER");
  const meters = chosenExporter("OTEL_METRICS_EXPORTER");
  if (traces === "none" && meters === "none") {
    providers = { shutdown: async () => {} };
    return providers.shutdown;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
  });

  const shutdowns = [];

  if (traces !== "none") {
    // The OTLP exporters are imported only when they are going to be used, so
    // the default console path does not load an HTTP exporter and a protobuf
    // encoder it will never call.
    const exporter =
      traces === "otlp"
        ? new (await import("@opentelemetry/exporter-trace-otlp-http")).OTLPTraceExporter()
        : new ConsoleSpanExporter();

    // Batch, not Simple. A SimpleSpanProcessor writes on the request thread at
    // the moment each span ends, which puts a JSON.stringify and a socket write
    // inside the hot path this instrumentation is supposed to observe rather
    // than slow down.
    const provider = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(exporter)] });
    // register() also installs the AsyncLocalStorage context manager, which is
    // what makes a span started in server.js the parent of one started deep
    // inside the OCR service without either of them passing a handle around.
    provider.register();
    shutdowns.push(() => provider.shutdown());
  }

  if (meters !== "none") {
    const exporter =
      meters === "otlp"
        ? new (await import("@opentelemetry/exporter-metrics-otlp-http")).OTLPMetricExporter()
        : new ConsoleMetricExporter();

    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000,
    });
    const provider = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    shutdowns.push(() => provider.shutdown());
  }

  providers = {
    traces,
    meters,
    shutdown: async () => {
      for (const stop of shutdowns) await stop().catch(() => {});
    },
  };
  return providers.shutdown;
}

/** What startTelemetry decided, for the /health payload and the boot log. */
export function telemetryState() {
  return providers
    ? { traces: providers.traces ?? "none", metrics: providers.meters ?? "none" }
    : { traces: "not started", metrics: "not started" };
}

const tracer = trace.getTracer(SERVICE_NAME);

/**
 * Run `fn` inside a span, ending it however `fn` finishes.
 *
 * The whole instrumentation surface of this codebase is this one function plus
 * the counters below. Anything more elaborate would be a framework, and a
 * framework is what makes instrumentation rot: nobody can see, at the call
 * site, what it costs or what it records.
 */
export async function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
      // A typed AppError is a decision the code made, not a crash. Recording
      // the code makes "which stage refused, and why" answerable from the
      // trace alone.
      if (error?.code) span.setAttribute("error.code", String(error.code));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The server span for one request, plus the means to make it the parent of
 * everything the request does.
 *
 * Two calls rather than one `withSpan`, because an HTTP span does not end when
 * the handler returns - it ends when the response finishes, which is a
 * different event and is the only one that knows the status code.
 */
export function startRequestSpan(name, attributes) {
  return tracer.startSpan(name, { kind: SpanKind.SERVER, attributes });
}

/** Run `fn` with `span` as the active span, so child spans attach to it. */
export function runInSpan(span, fn) {
  return context.with(trace.setSpan(context.active(), span), fn);
}

export { SpanStatusCode };

/** The active trace id, or null when nothing is being traced. */
export function currentTraceId() {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext && spanContext.traceId !== "00000000000000000000000000000000"
    ? spanContext.traceId
    : null;
}

// --- Metrics --------------------------------------------------------------
// Deliberately few. Every one of these answers a question that came up while
// this service was being measured, and none of them is a number nobody would
// act on.
//
// EVERY INSTRUMENT BELOW RESOLVES ON FIRST USE, NEVER AT IMPORT. That is not a
// style choice; it is the fix for a defect this file shipped with for about an
// hour and which a verification run caught. `trace.getTracer()` returns a proxy
// that picks up a provider registered later, so spans worked. `metrics.getMeter()`
// does not: called before `setGlobalMeterProvider`, it hands back a NoopMeter,
// and every instrument built from it is permanently, silently a no-op. Traces
// appeared, metrics did not, and nothing anywhere reported an error. Resolving
// the meter on the first `add`/`record` - which is inside a request, long after
// startup - makes the order impossible to get wrong.
function lazily(create) {
  let resolved = null;
  return () => (resolved ??= create(metrics.getMeter(SERVICE_NAME)));
}

function counter(name, options) {
  const resolve = lazily((meter) => meter.createCounter(name, options));
  return { add: (value, attributes) => resolve().add(value, attributes) };
}

function histogram(name, options) {
  const resolve = lazily((meter) => meter.createHistogram(name, options));
  return { record: (value, attributes) => resolve().record(value, attributes) };
}

/** How long a request took, split by route and by how it ended. */
export const requestDuration = histogram("http.server.request.duration", {
  description: "Request duration by route and outcome",
  unit: "ms",
});

/**
 * Cache lookups by result. The hit RATE is deliberately not a metric of its
 * own: a ratio cannot be aggregated across instances or re-windowed, whereas
 * two counters can, and the ratio is one division away at query time.
 */
export const cacheLookups = counter("analyze.cache.lookups", {
  description: "Result cache lookups, by whether they hit and on which key",
});

/** Retrieval latency, apart from the model call it precedes. */
export const retrievalDuration = histogram("rag.retrieval.duration", {
  description: "Hybrid retrieval duration for one query, embedding included",
  unit: "ms",
});

/**
 * Work the OCR pool refused. This is the number that says the queue bound is
 * doing something, and it is invisible in a duration histogram because a
 * refusal is fast.
 */
export const ocrRejections = counter("ocr.rejections", {
  description: "OCR jobs refused, by reason (queue_full, timeout, pool_restart)",
});

/**
 * Provider-reported tokens. Attributed prompt/completion because they price
 * differently everywhere and because a rising completion count with a flat
 * prompt count is a different problem from the reverse.
 */
export const llmTokens = counter("llm.tokens", {
  description: "Tokens reported by the model provider, by kind",
});

/**
 * OCR queue depth, observed rather than recorded.
 *
 * A gauge asked at export time, not a counter incremented on the request path:
 * depth is a level, and a level sampled by the exporter costs nothing per
 * request. Created here rather than at module scope so this file does not
 * import the OCR pool - which would drag Tesseract into every process that
 * merely wants a tracer, the eval harness included - and so the meter is
 * resolved after startTelemetry has registered a provider.
 */
export function observeOcrPool(readStats) {
  const gauge = metrics.getMeter(SERVICE_NAME).createObservableGauge("ocr.queue.depth", {
    description: "OCR jobs waiting for a worker, and jobs in flight",
  });

  gauge.addCallback((observer) => {
    const stats = readStats();
    if (!stats?.started) return;
    observer.observe(stats.queued, { state: "queued" });
    observer.observe(stats.inFlight, { state: "in_flight" });
  });
}

export default { startTelemetry, telemetryState, withSpan, currentTraceId, startRequestSpan, runInSpan };
