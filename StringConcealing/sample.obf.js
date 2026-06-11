"use strict";
function __bufToStr(buffer){ return Buffer.from(buffer).toString('utf-8'); }
function __p_smp_decode(str){
  var table="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~\"";
  var raw=""+(str||"");var len=raw.length;var ret=[];var b=0;var n=0;var v=-1;
  for(var i=0;i<len;i++){var p=table.indexOf(raw[i]);if(p===-1)continue;if(v<0){v=p;}else{v+=p*91;b|=v<<n;n+=(v&8191)>88?13:14;do{ret.push(b&255);b>>=8;n-=8;}while(n>7);v=-1;}}
  if(v>-1){ret.push((b|v<<n)&255);}
  return __bufToStr(ret);
}
var __p_smp_arr=[">OwJh>A","OrFK5+A","TzB"];
function __p_smp(index){return __p_smp_decode(__p_smp_arr[index]);}
module.exports = __p_smp(0) + " " + __p_smp(1) + " #" + __p_smp(2);
