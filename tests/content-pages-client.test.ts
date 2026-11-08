import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {contentPageQuery} from "../src/contentPages.js";

test("singular content pages preserve canonical resolver context separately from unrelated query loops",()=>{
  const params=new URLSearchParams("page=3&query-4-page=7&commentPage=2");
  assert.equal(contentPageQuery(params).query.toString(),"page=3");
  assert.equal(contentPageQuery(params,2).query.toString(),"page=2","canonical /2/ remains authoritative");
  assert.equal(params.get("query-4-page"),"7");
  assert.equal(params.get("commentPage"),"2");
  for(const page of ["0","-1","1.5","Infinity","2147483648","bad",""])
    assert.deepEqual(contentPageQuery(new URLSearchParams({page})),{page:1,query:new URLSearchParams()});
});
