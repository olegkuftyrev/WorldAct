import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import { readFootnotes, synchronizeFootnotes, rememberFootnotes } from "../src/editor/footnotes.js";
const parseHTML=(html:string)=>new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`,"text/html") as unknown as Document;
const reference=(id:string,number="*")=>`<sup class="fn" data-fn="${id}"><a href="#${id}" id="${id}-link">${number}</a></sup>`;
const block=(content:string,innerBlocks:any[]=[])=>({attributes:{content},innerBlocks});

test("native footnote sync orders nested and repeated references once, renumbers and restores deleted rich notes on undo",()=>{
  const cache=new Map(), notes=[{id:"fn-a",content:'A <strong>rich</strong> source <a href="https://example.invalid">link</a>'},{id:"fn-b",content:"B source"}];
  const original=[block("First "+reference("fn-a")),block("",[block("Second "+reference("fn-b"))])];
  const first=synchronizeFootnotes(original,reference("fn-a")+reference("fn-b"),notes,cache,parseHTML);
  assert.match(first.blocks[0].attributes.content,/>1<\/a>/);
  assert.match(first.blocks[1].innerBlocks[0].attributes.content,/>2<\/a>/);
  const moved=[first.blocks[1],first.blocks[0],block(reference("fn-b"))];
  const reordered=synchronizeFootnotes(moved,reference("fn-b")+reference("fn-a")+reference("fn-b"),first.footnotes,cache,parseHTML);
  assert.deepEqual(reordered.footnotes.map(note=>note.id),["fn-b","fn-a"]);
  assert.match(reordered.blocks[0].innerBlocks[0].attributes.content,/>1<\/a>/);
  const removed=synchronizeFootnotes([reordered.blocks[0]],reference("fn-b"),reordered.footnotes,cache,parseHTML);
  assert.equal(removed.footnotes.length,1);
  const undone=synchronizeFootnotes(original,reference("fn-a")+reference("fn-b"),removed.footnotes,cache,parseHTML);
  assert.deepEqual(undone.footnotes,notes);
  assert.equal(undone.footnotes[0].content,notes[0].content);
});

test("footnote metadata is bounded, malformed imports are recoverable and unchanged blocks retain identity",()=>{
  assert.deepEqual(readFootnotes("malformed"),[]);
  assert.deepEqual(readFootnotes('[{"id":"unsafe id","content":"x"},{"id":"fn-a","content":"x"},{"id":"fn-a","content":"duplicate"}]'),[{id:"fn-a",content:"x"}]);
  assert.throws(()=>readFootnotes([{id:"fn-a",content:"x".repeat(20001)}]),/supported limit/);
  const cache=new Map();rememberFootnotes(cache,Array.from({length:1100},(_,i)=>({id:"fn-"+i,content:"x"})));
  assert.equal(cache.size,1000);
  const blocks=[block("Plain <em>content</em>")];
  assert.equal(synchronizeFootnotes(blocks,"<p>Plain</p>",[],cache,parseHTML).blocks,blocks);
  const accordion=[block("",[block("",[block("First typed characters")])])];
  assert.equal(synchronizeFootnotes(accordion,"<p>First typed characters</p>",[],cache,parseHTML).blocks,accordion);
  const numbered=[block(reference("fn-a","1"))];
  assert.equal(synchronizeFootnotes(numbered,reference("fn-a","1"),[{id:"fn-a",content:"Source"}],cache,parseHTML).blocks,numbered);
  assert.throws(()=>synchronizeFootnotes([],Array.from({length:501},(_,i)=>reference("fn-"+i)).join(""),[],cache,parseHTML),/500/);
});
