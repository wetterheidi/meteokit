#!/usr/bin/env node
/**
 * Holt zwei Winter ICON-Oberflächendaten (Sicht, Niederschlag, T) aus dem
 * Historie-Archiv von Open-Meteo für die Stationen aus stations.json. Schon
 * vorhandene Dateien werden übersprungen. Auswertung: fit-snow-history.mjs.
 *
 *   node fetch-snow-history.mjs DIR
 */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const cfg=JSON.parse(readFileSync(new URL('./stations.json',import.meta.url)));
const out=process.argv[2];
const V="visibility,precipitation,rain,showers,snowfall,temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,cloud_cover_low";
const W=[["w2425","2024-12-01","2025-03-15"],["w2526","2025-12-01","2026-03-15"]];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const m of ["dwd_icon_eu","dwd_icon_d2"]) for(const [w,s,e] of W) for(const st of cfg.stations){
 const f=`${out}/${m}_${w}_${st.id}.json`; if(existsSync(f))continue;
 const u=`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&elevation=nan&hourly=${V}&models=${m}&start_date=${s}&end_date=${e}&timezone=UTC`;
 let d; for(let t=0;t<4;t++){const r=await fetch(u); if(r.ok){d=await r.json();break} console.log('retry',st.id,r.status,(await r.text()).slice(0,100)); await sleep(20000*(t+1))}
 if(!d){console.log('FAIL',m,w,st.id);continue}
 writeFileSync(f,JSON.stringify({id:st.id,lat:d.latitude,lon:d.longitude,elev:d.elevation,hourly:d.hourly}));
 await sleep(1500);
}
console.log('done');
