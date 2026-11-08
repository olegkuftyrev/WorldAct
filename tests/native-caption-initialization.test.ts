import test from './isolated-test.js';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

test('initial native captions preserve original HTML instead of a second createBlock normalization', async () => {
  const {window, document}=parseHTML('<html><body></body></html>');
  Object.defineProperty(document,'implementation',{value:{createHTMLDocument:()=>parseHTML('<html><body></body></html>').document}});
  Object.assign(globalThis,{window,document,DOMParser:window.DOMParser,Node:window.Node,MutationObserver:window.MutationObserver});
  const {registerBlockType,parse,createBlock}=await import('@wordpress/blocks');
  const {RichTextData}=await import('@wordpress/rich-text');
  const {createElement,RawHTML}=await import('@wordpress/element');
  const {parseEditorSource}=await import('../src/editor/editorSource.js');
  const {persistentBlockAttributes}=await import('../src/editor/blockAttributes.js');
  const schema={caption:{type:'rich-text' as const,role:'content' as const,source:'rich-text',selector:'figcaption'},editorSelection:{type:'number' as const,role:'local' as const,default:0}};
  registerBlockType('test/native-caption',{apiVersion:3,title:'Native caption boundary',category:'text',attributes:schema,save:({attributes}:any)=>createElement(RawHTML,null,`<figure><figcaption>${attributes.caption}</figcaption></figure>`)});
  for(const raw of ['Fresh <em>matching</em> &amp; &lt;literal&gt;','Plain matching caption','Literal &lt;strong&gt;text&lt;/strong&gt; &amp; "quotes"']){
    const html=`<!-- wp:test/native-caption --><figure><figcaption>${raw}</figcaption></figure><!-- /wp:test/native-caption -->`;
    const parsed=parse(html)[0],restored=parseEditorSource(html)[0];
    const nativeCaption=parsed.attributes.caption as InstanceType<typeof RichTextData>;
    assert.equal(nativeCaption.toString(),raw);
    assert.ok(restored.attributes.caption instanceof RichTextData,'retain genuine parsed rich text with its originalHTML');
    assert.equal(String(restored.attributes.caption),raw,'source Image exact metadata comparison must see the initial raw HTML');
    assert.equal(restored.attributes.editorSelection,undefined,'local selection is still omitted');
    assert.equal(typeof restored.clientId,'string');
    assert.equal(restored.isValid,parsed.isValid,'native recovery state remains intact');
    assert.equal(restored.isValid,true);
    const durable=persistentBlockAttributes(restored.attributes,schema);
    assert.equal(durable.caption,raw,'durable JSON serialization remains a string');
    if(raw.includes('&gt;')){
      const old=createBlock('test/native-caption',durable);
      assert.notEqual(String(old.attributes.caption),raw,'the previous parse→JSON→createBlock path changes the equality boundary');
      assert.equal(String(old.attributes.caption),raw.replaceAll('&gt;','>'));
    }
  }
});
