#!/usr/bin/env bash
# 代码级校验（不启动服务、不发 HTTP 请求）：
#   1. 所有 JS / Python 语法检查
#   2. 所有 server 模块 require 加载（index.js 是入口不加载；子进程脚本跳过）
#   3. better-sqlite3 原生模块架构检查 + SQLite 读写冒烟
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== 1. JS 语法检查 =="
jsfail=0
while IFS= read -r f; do
  if err=$(node --check "$f" 2>&1); then
    :
  else
    echo "  FAIL $f"; echo "$err" | sed 's/^/    /'; jsfail=1
  fi
done < <(find server tasks public -name '*.js' | sort)
[ $jsfail -eq 0 ] && echo "  全部通过"
[ $jsfail -eq 1 ] && fail=1

echo "== 2. Python 语法检查 =="
if python3 -m compileall -q server/runtime/py_lib tasks server/captcha_bank 2>&1; then
  echo "  全部通过"
else
  echo "  FAIL"; fail=1
fi

echo "== 3. server 模块加载 =="
if node -e "
const fs=require('fs'),path=require('path');
const files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.js'))files.push(p);}})('server');
const skip=['server/index.js','server/runtime/js-task-wrapper.js','server/runtime/manual-browser-session.js'];
let ok=0,bad=0;
for(const f of files.sort()){
  if(skip.includes(f)) continue;
  try{require('./'+f);ok++;}
  catch(e){console.error('  FAIL '+f+' -> '+e.message.split('\n')[0]);bad++;}
}
console.log('  加载成功 '+ok+' / 失败 '+bad);
process.exit(bad?1:0);
"; then :; else fail=1; fi

echo "== 4. better-sqlite3 架构 + 读写 =="
if node -e "
const os=require('os');
const binary='node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const buf=require('fs').readFileSync(binary);
const archByte=buf[18];
const want={arm64:0xb7,x64:0x3e}[os.arch()];
if(archByte!==want){console.error('  FAIL 原生模块架构不匹配, 期望 '+os.arch()+' (0x'+want.toString(16)+'), 实际 0x'+archByte.toString(16));process.exit(1);}
const db=new (require('better-sqlite3'))(':memory:');
db.exec('CREATE TABLE t(a)'); db.prepare('INSERT INTO t VALUES (?)').run(1);
if(db.prepare('SELECT a FROM t').get().a!==1){console.error('  FAIL SQLite 读写异常');process.exit(1);}
console.log('  OK  架构 '+os.arch()+' 匹配, SQLite 读写正常');
"; then :; else fail=1; fi

echo "========================================"
if [ $fail -eq 0 ]; then echo "✅ 全部校验通过"; else echo "❌ 存在失败项"; exit 1; fi
