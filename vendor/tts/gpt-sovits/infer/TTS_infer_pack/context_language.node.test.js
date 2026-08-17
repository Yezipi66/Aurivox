const { test } = require('node:test');
const assert = require('node:assert/strict');
const HAN=/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA=/[\u3040-\u30ff\u31f0-\u31ff]/;
const STRONG=new Set([...'嘅喺冇唔佢哋啲嚟咗咩嘢']);
const WEAK=new Set([...'咁呢嗰乜仲緊點睇畀俾嘞喎啩噉噃係攞揾瞓啱']);
function infer(s,base){if(KANA.test(s))return'ja';let n=0;for(const c of s){if(STRONG.has(c))n+=2;else if(WEAK.has(c))n+=1;else if(HAN.test(c))n-=.05}return n>=1.5?'yue':base}
test('kana context assigns shared Han to Japanese',()=>assert.equal(infer('今日は少し長い文章を読み上げてもらいます','yue'),'ja'));
test('strong Cantonese marker scores +2 and crosses threshold',()=>assert.equal(infer('我嘅近况','zh'),'yue'));
test('weak marker scores +1 and does not cross threshold alone',()=>assert.equal(infer('我呢近况','zh'),'zh'));
test('spaces and Latin do not affect Cantonese score',()=>assert.equal(infer('我 嘅 近况 Thank you','zh'),'yue'));
test('unclassified Han falls back to asset language',()=>assert.equal(infer('好','yue'),'yue'));
