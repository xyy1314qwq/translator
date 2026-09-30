const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {pathToFileURL}=require('node:url');
const path=require('node:path');

function storage(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  return {
    sql:{exec(query,...values){
      if(query.includes('CREATE TABLE')){db.exec(query);return;}
      const rows=db.prepare(query).all(...values);
      return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0]}};
    }},
    transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}},
  };
}

test('normal token refresh and translation cover the configured six-hour allowance',async t=>{
  const {UsageBudget,usageLimits}=await import(pathToFileURL(path.resolve(__dirname,'../usage-budget.js')));
  const budget=new UsageBudget(storage(t),usageLimits({}));
  const original=Date.now;t.after(()=>Date.now=original);
  const base=Date.UTC(2026,9,1,8);
  for(let seconds=0;seconds<6*3600;seconds+=10){
    Date.now=()=>base+seconds*1000;
    if(seconds%50===0)assert.doesNotThrow(()=>budget.token('192.0.2.10'),`token renewal at ${seconds}s`);
    budget.translation('192.0.2.10');
  }
});

test('daily audio resets at the UTC boundary, not when a budget object is reconstructed',async t=>{
  const {UsageBudget,usageLimits}=await import(pathToFileURL(path.resolve(__dirname,'../usage-budget.js')));
  const state=storage(t),limits=usageLimits({DAILY_AUDIO_SECONDS_PER_IP:'1'});
  const original=Date.now;t.after(()=>Date.now=original);
  Date.now=()=>Date.UTC(2026,9,1,23,59,59);
  const first=new UsageBudget(state,limits);first.audio('192.0.2.10',32000);
  const second=new UsageBudget(state,limits);
  assert.throws(()=>second.audio('192.0.2.10',2),/额度/);
  Date.now=()=>Date.UTC(2026,9,2,0,0,0);
  assert.doesNotThrow(()=>second.audio('192.0.2.10',32000));
  assert.throws(()=>second.audio('192.0.2.10',2),/额度/);
});
