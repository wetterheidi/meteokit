#!/usr/bin/env node
/**
 * Schnee-Kalibrierung aus dem Historie-Archiv von Open-Meteo: scheinbare
 * Fallgeschwindigkeit v_s aus ICON-Sicht und Schneerate am Boden, Kreuzprüfung
 * zwischen zwei Wintern, Regen als Kontrolle. Ergebnis und Grenzen:
 * docs/SICHTWEITE.md 1.6. Daten vorher mit fetch-snow-history.mjs holen.
 *
 *   node fit-snow-history.mjs DIR
 */
import {readFileSync,readdirSync} from 'node:fs';
import {sunAltitude} from '../../src/astro.js';
const dir=process.argv[2];
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const aS=T=>clamp(10-4*(T+2),6,10);
const night=(v,z)=>{const f=clamp((v/0.05)**.25,1.25,2.25);return z*v+(1-z)*v*f};
const invNight=(V,z)=>{let a=V/2.5,b=V;for(let i=0;i<50;i++){const m=(a+b)/2;night(m,z)>V?b=m:a=m}return (a+b)/2};
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))]};const med=a=>q(a,.5);
function load(model){const rows=[];for(const f of readdirSync(dir).filter(f=>f.startsWith(model+'_')&&f.endsWith('.json'))){
 const w=f.split('_').at(-2);const d=JSON.parse(readFileSync(dir+'/'+f));const H=d.hourly;
 for(let i=0;i<H.time.length-1;i++){const V=H.visibility[i],sb=H.snowfall[i],sa=H.snowfall[i+1],T=H.temperature_2m[i];if(V==null||sb==null||sa==null||T==null)continue;
  const z=clamp(Math.sin(sunAltitude(Date.parse(H.time[i]+'Z'),d.lat,d.lon)*Math.PI/180),0,.1)/.1;
  rows.push({st:d.id,w,V:V/1000,S:Math.min(sb,sa)/.7,sMax:Math.max(sb,sa)/.7,R:Math.min(H.rain[i],H.rain[i+1]),sh:Math.max(H.showers[i],H.showers[i+1]),rMax:Math.max(H.rain[i],H.rain[i+1]),T,rh:H.relative_humidity_2m[i],z});}}
 return rows}
// Feuchteterm grob aus RH2m (Var. 3, invfac=1, ohne Scherung), km
const rhTerm=rh=>{const r=clamp(rh/100,0,1);return Math.max(1,90-257.44*r+471.29*r*r-301.85*r*r*r)};
const pred=(r,C)=>{const v=Math.min(90,3.912/(aS(r.T)*C));return Math.min(night(v,r.z),rhTerm(r.rh))};
const score=(x,f)=>{const e=x.map(r=>Math.log(pred(r,f(r))/r.V));return {n:x.length,bias:+med(e).toFixed(2),in30:+(100*e.filter(v=>Math.abs(v)<=Math.log(1.3)).length/e.length).toFixed(1),in2x:+(100*e.filter(v=>Math.abs(v)<=Math.log(2)).length/e.length).toFixed(1)}};
function fitV(x){return med(x.map(r=>r.S/(3.6*3.912/invNight(r.V,r.z)/aS(r.T))))}
function fitPow(x){const p=x.map(r=>[Math.log(r.S),Math.log(3.912/invNight(r.V,r.z)/aS(r.T))]);let best=[1e9];for(let g=.4;g<=1.21;g+=.02){const lnA=med(p.map(([s,c])=>c-g*s));const e=med(p.map(([s,c])=>Math.abs(c-lnA-g*s)));if(e<best[0])best=[e,Math.exp(lnA),g]}return{alpha:best[1],gamma:best[2]}}
for(const m of ['dwd_icon_eu','dwd_icon_d2']){
 const R=load(m);console.log('\n#####',m);
 // Regen-Kontrolle: impliziter Faktor auf W=0.089 R^.84, nur R>=1 mm/h, kein Schnee, T>3, Schauer=0
 const rain=R.filter(r=>r.R>=1&&r.sMax===0&&r.T>3&&r.sh===0);
 const fac=rain.map(r=>{const b=3.912/invNight(r.V,r.z);return (b/2.24)**(1/.75)/(.089*r.R**.84)});
 console.log('Regen-Kontrolle R>=1: n',rain.length,'Faktor q25/50/75',q(fac,.25).toFixed(2),med(fac).toFixed(2),q(fac,.75).toFixed(2));
 const snow=R.filter(r=>r.S>=.1&&r.R===0&&r.sh===0&&r.T<=0.5);
 console.log('Schneestunden',snow.length);
 for(const [a,b] of [[-40,-5],[-5,-2],[-2,-1],[-1,.5]]){const x=snow.filter(r=>r.T>a&&r.T<=b);console.log(` T ${a}..${b}: n=${x.length} v_app med ${fitV(x).toFixed(3)}`)}
 for(const [tr,te] of [['w2425','w2526'],['w2526','w2425']]){
  const A=snow.filter(r=>r.w===tr),B=snow.filter(r=>r.w===te);
  const v=fitV(A),p=fitPow(A);
  console.log(`Train ${tr} (n=${A.length}) -> v=${v.toFixed(3)}, Potenz C=${p.alpha.toFixed(3)}*S^${p.gamma.toFixed(2)}; Test ${te}:`);
  console.log('  alt v=1      ',JSON.stringify(score(B,r=>r.S/3.6)));
  console.log('  v fest       ',JSON.stringify(score(B,r=>r.S/(3.6*v))));
  console.log('  Potenz       ',JSON.stringify(score(B,r=>p.alpha*r.S**p.gamma)));
 }
 for(const v of [1,.5,.3,.25,.2,.15,.1]) console.log(`  v=${v}`,JSON.stringify(score(snow,r=>r.S/(3.6*v))));
 console.log('alle: v',fitV(snow).toFixed(3),JSON.stringify(fitPow(snow)));
}
