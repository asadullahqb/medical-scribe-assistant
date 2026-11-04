/* Simple test script to exercise the /attribute endpoint on the local server.
   Usage: node server/test_attribution.js
*/

const payload = {
  segments: [
    { ts: Date.now(), text: 'Hi, Doctor.' },
    { ts: Date.now()+10, text: 'Hello, how can I help you today?' }
  ]
};

async function main(){
  try{
    const res = await fetch('http://localhost:8787/attribute',{
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    console.log('Response:', j);
  }catch(e){
    console.error('Error calling /attribute:', e);
  }
}

main();
