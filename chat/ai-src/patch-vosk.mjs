// Removes eval / new Function from vosk-browser's inlined emscripten worker
// (embind) so it runs under a CSP without 'unsafe-eval'. Same semantics as
// emscripten's DYNAMIC_EXECUTION=0 versions.
import fs from 'node:fs';

const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');
const tag = "createBase64WorkerFactory('";
const i = s.indexOf(tag) + tag.length;
const j = s.indexOf("'", i);
let w = Buffer.from(s.slice(i, j), 'base64').toString('latin1');

function swap(name, body) {
  const a = w.indexOf(`function ${name}(`);
  if (a < 0) throw new Error(name);
  let d = 0, k = w.indexOf('{', a);
  for (;; k++) { if (w[k] === '{') d++; else if (w[k] === '}' && !--d) break; }
  w = w.slice(0, a) + body + w.slice(k + 1);
}

swap('createNamedFunction', `function createNamedFunction(name,body){return {[name]:function(){return body.apply(this,arguments)}}[name]}`);

swap('craftInvokerFunction', `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expected=argCount-2;return function(){if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!");}var destructors=needsDestructorStack?[]:null;var wired=[];var thisWired;if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired);}for(var i=0;i<expected;++i){wired.push(argTypes[i+2].toWireType(destructors,arguments[i]));}var rv=cppInvokerFunc.apply(null,[cppTargetFunc].concat(wired));if(needsDestructorStack){runDestructors(destructors);}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var p=i===1?thisWired:wired[isClassMethodFunc?i-1:i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(p);}}}if(returns){return argTypes[0].fromWireType(rv);}}}`);

swap('__emval_get_method_caller', `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var invokerFunction=function(handle,name,destructors,args){var offset=0;var a=[];for(var i=0;i<argCount-1;++i){a.push(types[1+i].readValueFromPointer(args+offset));offset+=types[1+i]["argPackAdvance"];}var rv=handle[name].apply(handle,a);for(var i=0;i<argCount-1;++i){if(types[1+i]["deleteObject"]){types[1+i].deleteObject(a[i]);}}if(!retType.isVoid){return retType.toWireType(destructors,rv);}};return __emval_addMethodCaller(invokerFunction)}`);

if (/new Function|new_\(Function|\beval\(/.test(w)) throw new Error('eval left');
fs.writeFileSync(file, s.slice(0, i) + Buffer.from(w, 'latin1').toString('base64') + s.slice(j));
console.log('patched', w.length);
