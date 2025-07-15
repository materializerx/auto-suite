import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

console.log('🔧 Manual OAuth Setup for Reddit Bot');
console.log('');
console.log('Since automatic OAuth failed, let\'s set up authentication manually.');
console.log('');
console.log('📋 Steps:');
console.log('1. Go to your Reddit app settings: https://www.reddit.com/prefs/apps');
console.log('2. Edit your app');
console.log('3. Change redirect URI to: http://localhost:3000/api/auth/callback');
console.log('4. Save the changes');
console.log('5. Run: npm run setup-bot-oauth');
console.log('');
console.log('🔄 Alternative: Use script authentication (simpler but requires Reddit password)');
console.log('');

const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Do you want to use script authentication instead? (y/n): ', (answer: string) => {
  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    console.log('');
    console.log('📝 For script authentication, you need:');
    console.log('1. Create a "script" type app at https://www.reddit.com/prefs/apps');
    console.log('2. Add these to your .env.local:');
    console.log('   REDDIT_BOT_USERNAME=your_reddit_username');
    console.log('   REDDIT_BOT_PASSWORD=your_reddit_password');
    console.log('3. Update the commenter script to use password authentication');
    console.log('');
    console.log('⚠️  Note: This is less secure than OAuth but simpler to set up.');
  } else {
    console.log('');
    console.log('✅ Please update your Reddit app redirect URI and try again.');
  }
  
  rl.close();
});