import test from "node:test";
import assert from "node:assert/strict";
import {parseHTML} from "linkedom";
import {scrollToMoreFragment} from "../src/contentFragments.js";

test("asynchronous More fragments scroll only the matching mounted content and cancel on cleanup",()=>{
  const {document,window}=parseHTML('<html><body><header></header><main><span id="more-42"></span><p>Full content.</p></main></body></html>');
  Object.defineProperty(window,"location",{value:{hash:"#more-42"}});
  const frames=new Map<number,FrameRequestCallback>();let next=0,scrolls=0;
  window.requestAnimationFrame=(callback)=>{frames.set(++next,callback);return next};
  window.cancelAnimationFrame=(id)=>{frames.delete(id)};
  document.getElementById("more-42")!.scrollIntoView=()=>{scrolls++};
  scrollToMoreFragment(document.querySelector("header") as unknown as HTMLElement);assert.equal(frames.size,0);
  let cleanup=scrollToMoreFragment(document.querySelector("main") as unknown as HTMLElement);assert.equal(frames.size,1);
  cleanup();assert.equal(frames.size,0);assert.equal(scrolls,0);
  cleanup=scrollToMoreFragment(document.querySelector("main") as unknown as HTMLElement);for(const callback of frames.values())callback(0);assert.equal(scrolls,1);cleanup();
  for(const hash of ["#comment-42","#more-42%22%20onclick%3Dalert(1)","#more-%E0%A4%A","#more-999"]){window.location.hash=hash;scrollToMoreFragment(document as unknown as Document);assert.equal(frames.size,0);}
});
