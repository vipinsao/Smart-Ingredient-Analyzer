// Test script to validate the backend with the provided image
import fs from 'fs';
import fetch from 'node-fetch';
import sharp from 'sharp';

// Test the backend with a sample image
async function testBackend() {
  try {
    console.log('🧪 Testing backend with food label image...');
    
    // For testing purposes, we'll create a mock base64 image
    // In real usage, this would come from the frontend
    const testImagePath = './test-sample.jpg';
    
    // Create a simple test image if it doesn't exist
    if (!fs.existsSync(testImagePath)) {
      console.log('📝 Creating test image...');
      await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      })
      .jpeg()
      .toFile(testImagePath);
    }
    
    // Read and convert to base64
    const imageBuffer = fs.readFileSync(testImagePath);
    const base64Image = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
    
    console.log(`📊 Test image size: ${(imageBuffer.length / 1024).toFixed(1)}KB`);
    
    // Test the API endpoint
    const response = await fetch('http://localhost:5000/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: base64Image,
        fastMode: true,
        isMobile: false
      })
    });
    
    console.log(`📡 Response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Error response:', errorText);
      return;
    }
    
    const result = await response.json();
    console.log('✅ Success! Response:', JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testBackend();