import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as demos from '../demos.mjs';

// Execute the actual UI functions and event wiring with a small DOM stand-in.
// Kit calls use real pinned package exports. Browser rendering is a separate gate.
function harness() {
  const ids=new Map();
  class Node {
    constructor(tag='div') {this.tagName=tag;this.children=[];this.attrs={};this.style={setProperty(){}};this.dataset={};this.events={};this.text='';this.hidden=false;this.disabled=false;this.value='';this.classes=new Set();this.classList={add:(...names)=>names.forEach(n=>this.classes.add(n)),remove:(n)=>this.classes.delete(n),contains:(n)=>this.classes.has(n)};}
    set id(value){this._id=value;ids.set(value,this);}get id(){return this._id;}
    set textContent(v){this.text=String(v);this.children=[];}get textContent(){return this.text+this.children.map(n=>typeof n==='string'?n:n.textContent).join('');}
    append(...nodes){this.children.push(...nodes);}prepend(...nodes){this.children.unshift(...nodes);}replaceChildren(...nodes){this.text='';this.children=nodes;}
    setAttribute(k,v){this.attrs[k]=String(v);}removeAttribute(k){delete this.attrs[k];}
    addEventListener(k,fn){(this.events[k]??=[]).push(fn);}fire(k,event={}){return Promise.all((this.events[k]??[]).map(fn=>fn({currentTarget:this,target:this,...event})));}
    focus(){document.activeElement=this;}remove(){}
    querySelector(s){return this.querySelectorAll(s)[0]??null;}
    querySelectorAll(s){const all=this.children.flatMap(n=>typeof n==='string'?[]:[n,...n.querySelectorAll('*')]);return all.filter(n=>s==='*'||s.startsWith('.')&&(n.className??'').split(' ').includes(s.slice(1))||s.startsWith('input[name=')&&n.tagName==='input'&&n.name===s.match(/name="([^"]+)"/)[1]&&n.checked);}
  }
  for(const id of ['view-code','copy-report','reg','reg-plate','fields','examples','timing','result','code-view','foot','kit-select','kit-title','kit-question','announce','copy-link','share-link','link-status']) {const n=new Node();n.id=id;}
  const tabs=['input','result'].map(name=>{const n=new Node('button');n.dataset.paneTab=name;return n;});
  const groups=new Map(['.pane-actions','.result-title','#result-pane > .pane-head'].map(selector=>[selector,new Node()]));
  const document={getElementById:id=>ids.get(id),createElement:tag=>new Node(tag),createTextNode:t=>String(t),body:new Node('body'),querySelector:s=>s==='meta[name="kit-base"]'?null:groups.get(s)??ids.get('fields').querySelector(s),querySelectorAll:s=>s==='[data-pane-tab]'?tabs:[],activeElement:null};
  const copies=[];const timers=[];const vizCalls=[];
  const sandbox={...demos,document,structuredClone,performance,console,URL,JSON,Map,Set,matchMedia:()=>({matches:false}),setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout(){},navigator:{clipboard:{writeText:async t=>copies.push(t)}},location:{origin:'https://example.test',pathname:'/',hash:''},renderViz:(...args)=>{vizCalls.push(args);return null;}};
  const source=readFileSync(new URL('../app.mjs',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
  const beforeBoot=source.slice(0,source.indexOf('// -------------------------------------------------------------------- boot'));
  const hashPart=source.slice(source.indexOf('function readHash()'),source.indexOf("$('copy-link').addEventListener"));
  const reportPart=source.slice(source.indexOf("COPY_REPORT.addEventListener('click'"),source.indexOf("VIEW_CODE.addEventListener('click'"));
  const tabsPart=source.slice(source.indexOf('for (const button of document.querySelectorAll(\'[data-pane-tab]\')) button.addEventListener'),source.indexOf("setPane('result');"));
  const linkPart=source.slice(source.indexOf("$('copy-link').addEventListener"),source.indexOf('// Share on phones'));
  vm.createContext(sandbox);vm.runInContext(beforeBoot+hashPart+reportPart+tabsPart+linkPart+`\nglobalThis.api={state,modules,renderFields,run,edited,selectKit,showCode,hideCode,readHash,setPane,showRejected,showOffline,showStale};`,sandbox);
  return {api:sandbox.api,ids,tabs,copies,timers,vizCalls,document,sandbox};
}
async function setup(id='grounding-kit') {
  const h=harness();const k=demos.KITS.find(k=>k.id===id);h.api.state.kit=k;h.api.modules.set(k.id,Promise.resolve(await import(k.id)));h.api.renderFields(structuredClone(k.presets.at(-1).input));await h.api.run();return h;
}
test('HK07: copied reports link to the input that produced the displayed verdict', async () => {
  const h=await setup();h.ids.get('f-grounding-kit-text').value='A new uncited claim.';await h.ids.get('copy-report').fire('click');
  const token=h.copies[0].split('~')[1].split(')')[0];assert.deepEqual(demos.decodeExample(h.api.state.kit,token),structuredClone(h.api.state.input));
  h.api.edited();assert.equal(h.ids.get('copy-report').disabled,true);assert.ok(h.ids.get('result').classList.contains('is-stale'));
});
test('HK07: edit invalidation prevents an older outstanding run from replacing the verdict',async()=>{
  const h=await setup();let finish, started;const began=new Promise(resolve=>started=resolve);const original=h.api.state.kit;h.api.state.kit={...original,run:()=>new Promise(resolve=>{finish=resolve;started();})};
  const previous=h.api.state.result;const pending=h.api.run();await began;h.api.edited();finish({...previous,headline:'old outstanding run'});await pending;assert.equal(h.api.state.result.headline,previous.headline);
});
test('HK08: invalid JSON, rejected input and offline failure expose result view and discard code',async()=>{
  for(const kind of ['json','reject','offline']) {
    const h=await setup();h.api.showCode();assert.equal(h.ids.get('result').hidden,true);
    if(kind==='json'){h.ids.get('f-grounding-kit-evidence').value='{';h.api.edited();await h.api.run();}
    if(kind==='reject'){h.ids.get('f-grounding-kit-evidence').value='[]';await h.api.run();}
    if(kind==='offline')h.api.showOffline(h.api.state.kit);
    assert.equal(h.ids.get('result').hidden,false);assert.equal(h.ids.get('code-view').hidden,true);assert.equal(h.ids.get('code-view').textContent,'');
    assert.equal(h.ids.get('copy-report').disabled,true);
    if(kind==='reject')assert.match(h.ids.get('result').textContent,/This input could not be checked/);
  }
});
test('HK16: oversize links do not copy or silently use a preset',async()=>{
  const h=await setup();h.ids.get('f-grounding-kit-text').value='x'.repeat(12000);await h.ids.get('copy-link').fire('click');
  h.timers.filter(t=>t.delay===30).forEach(t=>t.fn());assert.equal(h.copies.length,0);assert.match(h.ids.get('link-status').textContent,/too large to share/);assert.equal(h.ids.get('link-status').hidden,false);
});
test('HK17: malformed fragments are refused without throwing or silently presenting them as restored',()=>{
  const h=harness();for(const hash of ['#%','#grounding-kit~%E0%A4%A','#grounding-kit~not-base64!']) {h.sandbox.location.hash=hash;const parsed=h.api.readHash();assert.equal(parsed.kit,null);assert.equal(parsed.shared,null);h.timers.filter(t=>t.delay===30).forEach(t=>t.fn());assert.match(h.ids.get('link-status').textContent,/This example link could not be read/);assert.equal(h.ids.get('link-status').hidden,false);}
});
test('HK23: reproduction commands include the displayed kit version',async()=>{
  const h=await setup();h.api.showCode();assert.match(h.ids.get('code-view').textContent,/npm install grounding-kit@0.2.1/);
  const source=readFileSync(new URL('../app.mjs',import.meta.url),'utf8');assert.ok(!source.includes('npm install ${kit.id}`'));
});
test('HK25: pane controls use ordinary toggle-button semantics with an inside focus ring',async()=>{
  const h=await setup();await h.tabs[0].fire('click');assert.equal(h.tabs[0].attrs['aria-pressed'],'true');assert.equal(h.tabs[1].attrs['aria-pressed'],'false');
  const html=readFileSync(new URL('../src/page.html',import.meta.url),'utf8');assert.doesNotMatch(html,/role="tab(?:list)?"/);assert.match(html,/\.pane-tabs button:focus-visible[^}]*outline-offset: -/);
});
test('HK22: control borders have at least 3:1 contrast in both themes',()=>{
  const html=readFileSync(new URL('../src/page.html',import.meta.url),'utf8');
  const luminance=hex=>{const c=hex.match(/[a-f\d]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
  const blocks=[...html.matchAll(/:root(?:[^\{]*)\{([^}]+)\}/g)].map(m=>m[1]).filter(b=>b.includes('--sheet:'));
  for(const b of blocks){const color=k=>b.match(new RegExp(`--${k}:\\s*(#[a-f\\d]{6})`,'i'))?.[1];assert.ok(color('control-border'),'separate control border');for(const k of ['sheet','code-bg','paper']){const a=luminance(color('control-border')),z=luminance(color(k));assert.ok((Math.max(a,z)+.05)/(Math.min(a,z)+.05)>=3,`${k} contrast`);}}
  for(const selector of ['.btn-small','.chip','.field textarea, .field input[type="text"]','.segmented label']){const rule=html.slice(html.indexOf(selector+' {')).split('}')[0];assert.match(rule,/var\(--control-border\)/);}
});
test('unsafe input is rendered as text in UI code and errors',async()=>{
  const h=await setup();const attack='<img src=x onerror=alert(1)>';h.api.showRejected(h.api.state.kit,new Error(attack));assert.match(h.ids.get('result').textContent,/<img/);
  const source=readFileSync(new URL('../app.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\.innerHTML\s*=/);
});

test('unsafe HTML sinks are absent from both UI renderers',()=>{
  for(const file of ['app.mjs','viz.mjs'])assert.doesNotMatch(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'),/\.innerHTML\s*=/);
});


test('review 3: selection and a successful rerun clear obsolete link errors', async () => {
  const h = await setup();
  h.ids.get('link-status').hidden = false;
  h.api.selectKit('grounding-kit');
  assert.equal(h.ids.get('link-status').hidden, true);
  await h.api.run();
  h.ids.get('link-status').hidden = false;
  await h.api.run();
  assert.equal(h.ids.get('link-status').hidden, true);
});

test('review 4: keystrokes redraw only when leaving code view', async () => {
  const h = await setup();
  const initial = h.vizCalls.length;
  for (let i = 0; i < 5; i++) h.api.edited();
  assert.equal(h.vizCalls.length, initial);
  h.api.showCode();
  h.api.edited();
  assert.equal(h.vizCalls.length, initial + 1);
  h.api.edited();
  assert.equal(h.vizCalls.length, initial + 1);
});
