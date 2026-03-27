const {useState,useEffect,useRef,useCallback,useMemo}=React;
const C={bg:'#334155',card:'#fff',border:'#cbd5e1',accent:'#008965',green:'#16a34a',red:'#dc2626',orange:'#d97706',purple:'#9333ea',cyan:'#0891b2',text:'#1e293b',dim:'#64748b',muted:'#94a3b8'};
const MC={Raboteuse:'#008965',Balayeuse:'#16a34a',Citerne:'#0891b2'};
const FC={'2h':'#6b7280','4h':'#008965','6h':'#d97706','8h':'#16a34a','Transfert':'#9333ea','Demi-journee':'#d97706','Journee':'#16a34a'};
const SKEY='roadmanager-v5';
if(!window.storage||typeof window.storage.get!=='function'){window.storage={get:function(k){try{return Promise.resolve(localStorage.getItem(k))}catch(e){return Promise.resolve(null)}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}return Promise.resolve()}};}
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const defaultData=()=>({depots:[],employees:[],machines:[],trucks:[],cars:[],clients:[],jobs:[],forfaits:{},timeEntries:[],timeEntriesValidated:[],parts:[],interventions:[],panneReports:[],fuelPrice:1.72,nightPct:30,adminUser:'admin',adminPass:'admin',empPasswords:{},workDaysPerMonth:22,monthlyRent:0,monthlyAdmin:0,monthlyInsuranceRC:0,yearStart:fmtDateISO(new Date(new Date().getFullYear(),0,1)),weeklyHoursNormal:35,overtime25Threshold:35,overtime50Threshold:43,refHoursPerDay:1});
const PART_CATS=['pneu','filtre','courroie','dent','roulement','electrique','hydraulique','autre'];
const INTER_TYPES=['reparation','entretien','changement_piece','panne'];
const SEVERITIES=['urgent','normal','mineur'];
const sb=window.supabaseClient;
// localStorage helpers
const localLoad=()=>{try{for(const k of[SKEY,'roadmanager-v4','roadmanager-v3','roadmanager-v2','roadmanager-data']){const raw=localStorage.getItem(k);if(raw){const d=JSON.parse(raw);if(k!==SKEY)localStorage.setItem(SKEY,JSON.stringify(d));return{...defaultData(),...d};}}}catch(e){}return null};
const localSave=(d)=>{try{localStorage.setItem(SKEY,JSON.stringify(d))}catch(e){}};
// Supabase load/save with localStorage fallback
const loadData=async()=>{if(sb){try{const{data:row,error}=await sb.from('app_data').select('data').eq('id','main').single();if(!error&&row&&row.data&&Object.keys(row.data).length>0){const merged={...defaultData(),...row.data};localSave(merged);console.log('Loaded from Supabase');return merged}}catch(e){console.warn('Supabase load failed, fallback localStorage',e)}}const local=localLoad();if(local){if(sb){try{await sb.from('app_data').upsert({id:'main',data:local,updated_at:new Date().toISOString()});console.log('Migrated localStorage to Supabase')}catch(e){console.warn('Migration to Supabase failed',e)}}return local}return defaultData()};
const mergeArraysById=(local,remote)=>{if(!remote||!remote.length)return local||[];if(!local||!local.length)return remote;const map=new Map();remote.forEach(item=>{if(item&&item.id)map.set(item.id,item)});local.forEach(item=>{if(item&&item.id)map.set(item.id,item)});return[...map.values()]};
const saveData=async(d)=>{localSave(d);if(sb){try{const{data:row}=await sb.from('app_data').select('data').eq('id','main').single();if(row&&row.data){const remote=row.data;const merged={...d};merged.timeEntries=mergeArraysById(d.timeEntries,remote.timeEntries);merged.jobs=mergeArraysById(d.jobs,remote.jobs);merged.panneReports=mergeArraysById(d.panneReports,remote.panneReports);merged.interventions=mergeArraysById(d.interventions,remote.interventions);merged.parts=mergeArraysById(d.parts,remote.parts);const{error}=await sb.from('app_data').upsert({id:'main',data:merged,updated_at:new Date().toISOString()});if(error)console.error('Supabase save error:',error);else{localSave(merged);console.log('Saved to Supabase (merged)')}}else{const{error}=await sb.from('app_data').upsert({id:'main',data:d,updated_at:new Date().toISOString()});if(error)console.error('Supabase save error:',error);else console.log('Saved to Supabase')}}catch(e){console.warn('Supabase save failed',e)}}};
const subscribeToChanges=(callback)=>{if(!sb)return()=>{};const channel=sb.channel('app_data_changes').on('postgres_changes',{event:'UPDATE',schema:'public',table:'app_data',filter:'id=eq.main'},(payload)=>{if(payload.new&&payload.new.data){const merged={...defaultData(),...payload.new.data};localSave(merged);callback(merged)}}).subscribe();return()=>{sb.removeChannel(channel)}};
const pad2=n=>String(n).padStart(2,'0');
const fmtDate=d=>{const dt=new Date(d);const j=['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];const m=['Jan','Fev','Mar','Avr','Mai','Jun','Jul','Aou','Sep','Oct','Nov','Dec'];return j[dt.getDay()]+' '+dt.getDate()+' '+m[dt.getMonth()]+' '+dt.getFullYear()};
const fmtDateISO=d=>{const dt=new Date(d);return dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate())};
const fmtMoney=n=>Number(n||0).toFixed(2).replace('.',',')+' EUR';
const fmtDuration=min=>{const h=Math.floor(min/60);const m=Math.round(min%60);return h+'h'+pad2(m)};
const parseCoords=s=>{if(!s)return null;const p=String(s).split(',').map(Number);return p.length===2&&!isNaN(p[0])&&!isNaN(p[1])?p:null};
const haversine=(a,b)=>{const R=6371,toR=n=>n*Math.PI/180;const dLat=toR(b[0]-a[0]),dLon=toR(b[1]-a[1]);const x=Math.sin(dLat/2)**2+Math.cos(toR(a[0]))*Math.cos(toR(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))};
const osmRoute=async(from,to)=>{const urls=[`https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`,`https://routing.openstreetmap.de/routed-car/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`];for(const url of urls){try{const r=await fetch(url);const j=await r.json();if(j.routes&&j.routes[0])return{km:+(j.routes[0].distance/1000).toFixed(1),min:+(j.routes[0].duration/60).toFixed(0)}}catch(e){}}const km=+(haversine(from,to)*1.3).toFixed(1);return{km,min:+((km/80)*60).toFixed(0)}};
const searchAddress=async q=>{try{const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=fr&limit=5&q=${encodeURIComponent(q)}`);return await r.json()}catch(e){return[]}};
const getDepotCoords=(data,id)=>{const d=(data.depots||[]).find(x=>x.id===id);if(!d||!d._coords)return null;return parseCoords(typeof d._coords==='string'?d._coords:d._coords.join(','))};
const getEmpCoords=(data,id)=>{const e=(data.employees||[]).find(x=>x.id===id);if(!e||!e._coords)return null;return parseCoords(typeof e._coords==='string'?e._coords:e._coords.join(','))};
const getStartCoords=(data,job)=>job.startFrom==='home'?getEmpCoords(data,job.employeeId):getDepotCoords(data,job.startFrom);
const getEndCoords=(data,job)=>job.endAt==='home'?getEmpCoords(data,job.employeeId):getDepotCoords(data,job.endAt);
const getMachineFuelType=(data,mid)=>{const m=(data.machines||[]).find(x=>x.id===mid);return m&&m.type==='Raboteuse'?'gazole':'gnr'};
const getFuelPrice=(data,ft,did)=>{if(did){const d=(data.depots||[]).find(x=>x.id===did);if(d){if(ft==='gnr'&&d.gnrPrice>0)return d.gnrPrice;if(ft==='gazole'&&d.gazolePrice>0)return d.gazolePrice;}}for(const d of(data.depots||[])){if(ft==='gnr'&&d.gnrPrice>0)return d.gnrPrice;if(ft==='gazole'&&d.gazolePrice>0)return d.gazolePrice;}return data.fuelPrice||1.72};
const getForfaitKey=(data,cid,machine)=>{const cl=(data.clients||[]).find(x=>x.id===cid);const p=(cl&&cl.forfaitType==='specific')?cid:'standard';if(!machine)return null;if(machine.type==='Raboteuse')return p+'_rab_'+(machine.width||'');if(machine.type==='Balayeuse')return p+'_bal';if(machine.type==='Citerne')return p+'_cit';return null};
const getForfaitPrice=(data,cid,machine,ft,citOpt,isNight)=>{let k=getForfaitKey(data,cid,machine);if(!k)return 0;if(machine&&machine.type==='Citerne'&&citOpt)k+='_'+citOpt;const g=data.forfaits[k];if(!g)return 0;let pr=g[ft]||0;if(isNight)pr=pr*(1+(data.nightPct||30)/100);return Math.round(pr*100)/100};
const getTransferPrice=(data,cid,machine,citOpt,isNight)=>getForfaitPrice(data,cid,machine,'Transfert',citOpt,isNight);
const forfaitHours=f=>({'2h':2,'4h':4,'6h':6,'8h':8,'Demi-journee':4,'Journee':8}[f]||4);

const TEMPS_PLUS_DEPART=25;
const TEMPS_PLUS_ARRIVEE=30;
const TOLERANCE_MINUTES=5;

const calcTheoreticalTimes=(job,data,pauseMinFromTE)=>{
const tpDepart=(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const tpArrivee=(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const tol=(data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES);
if(!job.billingStart)return null;
const[bh,bm]=(job.billingStart||'08:00').split(':').map(Number);
if(isNaN(bh)||isNaN(bm))return null;
const billMin=bh*60+bm;
const trajetAller=Number(job.travelMinAller)||0;
const trajetRetour=Number(job.travelMinRetour)||0;
const startMin=billMin-trajetAller-tpDepart;
const fh=forfaitHours(job.forfaitType);
const pMin=Number(pauseMinFromTE)||0;
const endMin=billMin+fh*60+pMin+trajetRetour+tpArrivee;
const fmtT=m=>{const mm=((m%1440)+1440)%1440;return pad2(Math.floor(mm/60))+':'+pad2(mm%60)};
return{theoStart:fmtT(startMin),theoEnd:fmtT(endMin),theoStartMin:startMin,theoEndMin:endMin,tolerance:tol};
};

const Mod=({title,onClose,children,width})=>(
<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}} onClick={onClose}>
<div style={{background:'#fff',borderRadius:12,padding:24,width:width||500,maxWidth:'95vw',maxHeight:'90vh',overflow:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}} onClick={e=>e.stopPropagation()}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
<h3 style={{margin:0,fontSize:18}}>{title}</h3>
<button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.dim}}>x</button>
</div>{children}</div></div>
);
const Fl=({label,children})=>(<div style={{marginBottom:12}}><label style={{display:'block',fontSize:13,fontWeight:600,color:C.dim,marginBottom:4}}>{label}</label>{children}</div>);
const inputStyle={width:'100%',padding:'8px 12px',border:'1px solid '+C.border,borderRadius:6,fontSize:14,outline:'none'};
const btnStyle=(color,full)=>({padding:'8px 16px',background:full?color:'transparent',color:full?'#fff':color,border:'2px solid '+color,borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14});
const Bg=({text,color,style:s})=>(<span style={{display:'inline-block',padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:(color||C.accent)+'18',color:color||C.accent,...s}}>{text}</span>);
const SentBg=()=>(<Bg text="Envoye" color={C.green}/>);
const EBtn=({onClick})=>(<button onClick={e=>{e.stopPropagation();onClick()}} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.dim}}>&#9998;</button>);
const CtBadge=({dateStr,label})=>{if(!dateStr)return null;const diff=Math.floor((new Date(dateStr)-new Date())/86400000);const color=diff<0?C.red:diff<30?C.orange:C.green;return(<Bg text={label+': '+dateStr} color={color}/>)};

const LoginScreen=({onLogin,data})=>{
const[id,setId]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');
const submit=()=>{if(id===(data.adminUser||'admin')&&pw===(data.adminPass||'admin')){onLogin('admin',null);return}const emp=(data.employees||[]).find(e=>e.login===id);if(emp&&(data.empPasswords||{})[emp.id]===pw){onLogin('employee',emp.id);return}setErr('Identifiant ou mot de passe incorrect')};
return(
<div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'linear-gradient(135deg,#004d3a,#008965)'}}>
<div style={{background:'#fff',borderRadius:16,padding:40,width:380,maxWidth:'90vw',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
<div style={{textAlign:'center',marginBottom:24}}><img src="logo.png" alt="SONECO" style={{width:200,marginBottom:8}}/><h1 style={{fontSize:20,color:C.text}}>RoadManager</h1><p style={{color:C.dim,fontSize:14}}>Gestion de travaux routiers</p></div>
{err&&<div style={{background:'#fef2f2',color:C.red,padding:8,borderRadius:6,fontSize:13,marginBottom:12}}>{err}</div>}
<Fl label="Identifiant"><input style={inputStyle} value={id} onChange={e=>setId(e.target.value)} placeholder="admin"/></Fl>
<Fl label="Mot de passe"><input style={inputStyle} type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="********" onKeyDown={e=>e.key==='Enter'&&submit()}/></Fl>
<button onClick={submit} style={{...btnStyle(C.accent,true),width:'100%',padding:12,marginTop:8}}>Connexion</button>
</div></div>);};

// ======== MISSION FORM ========
const MissionForm=({data,save,job,onClose,selectedDate,selectedEmpId})=>{
const[empId,setEmpId]=useState(job?job.employeeId:selectedEmpId||'');
const[machId,setMachId]=useState(job?job.machineId:'');
const[clientId,setClientId]=useState(job?job.clientId:'');
const[newClient,setNewClient]=useState('');
const[agency,setAgency]=useState(job?job.agencyName||'':'');
const[siteMgr,setSiteMgr]=useState(job?job.siteManager||'':'');
const[siteMgrPh,setSiteMgrPh]=useState(job?job.siteManagerPhone||'':'');
const[location,setLocation]=useState(job?job.location||'':'');
const[gps,setGps]=useState(job?job.gps||'':'');
const[forfait,setForfait]=useState(job?job.forfaitType||'':'');
const[citOpt,setCitOpt]=useState(job?job.citOption||'Avec chauffeur':'Avec chauffeur');
const[price,setPrice]=useState(job?job.priceForfait||0:0);
const[isNight,setIsNight]=useState(job?!!job.isNight:false);
const[hasTransfer,setHasTransfer]=useState(job?!!job.hasTransfer:false);
const[transferPr,setTransferPr]=useState(job?job.transferPrice||0:0);
const[billStart,setBillStart]=useState(job?job.billingStart||'08:00':'08:00');
const[startFrom,setStartFrom]=useState(job?job.startFrom||'':'');
const[endAt,setEndAt]=useState(job?job.endAt||'':'');
const[fuelL,setFuelL]=useState(job?job.machineFuelL||0:0);
const[fuelDepot,setFuelDepot]=useState(job?job.machineFuelDepot||'':'');
const[addrRes,setAddrRes]=useState([]);
const[departOpts,setDepartOpts]=useState([]);
const[arriveeOpts,setArriveeOpts]=useState([]);
const[routeCalcing,setRouteCalcing]=useState(false);
const timer=useRef(null);
const routeTimer=useRef(null);
const dateStr=selectedDate||fmtDateISO(new Date());
const dayJobs=(data.jobs||[]).filter(j=>j.date===dateStr&&(!job||j.id!==job.id));
const usedM=dayJobs.filter(j=>j.employeeId!==empId).map(j=>j.machineId);
const emp=(data.employees||[]).find(e=>e.id===empId);
const machines=(data.machines||[]).filter(m=>!usedM.includes(m.id)||(job&&job.machineId===m.id)||(emp&&emp.machineId===m.id));
const client=clientId?(data.clients||[]).find(c=>c.id===clientId):null;
const mach=machId?(data.machines||[]).find(m=>m.id===machId):null;
useEffect(()=>{if(!machId&&emp&&emp.machineId)setMachId(emp.machineId)},[empId]);
useEffect(()=>{if(mach&&forfait){const p=getForfaitPrice(data,clientId,mach,forfait,citOpt,isNight);if(p)setPrice(p)}},[forfait,clientId,machId,citOpt,isNight]);
useEffect(()=>{if(hasTransfer&&mach){const t=getTransferPrice(data,clientId,mach,citOpt,isNight);if(t)setTransferPr(t)}},[hasTransfer,clientId,machId,citOpt,isNight]);
useEffect(()=>{if(client&&siteMgr){const s=(client.siteManagers||[]).find(x=>x.name===siteMgr);if(s)setSiteMgrPh(s.phone||'')}},[siteMgr,clientId]);
const doAddr=useCallback(q=>{if(timer.current)clearTimeout(timer.current);if(q.length<3){setAddrRes([]);return}timer.current=setTimeout(()=>{searchAddress(q).then(r=>setAddrRes(r||[]))},500)},[]);
// --- Route cards calculation ---
const calcAllRoutes=useCallback(async()=>{const co=parseCoords(gps);if(!co){setDepartOpts([]);setArriveeOpts([]);return}setRouteCalcing(true);const depOpts=[];const arrOpts=[];const empObj=(data.employees||[]).find(e=>e.id===empId);const empCo=empObj&&empObj._coords?parseCoords(typeof empObj._coords==='string'?empObj._coords:empObj._coords.join(',')):null;// Domicile
if(empCo){try{const rA=await osmRoute(empCo,co);const rR=await osmRoute(co,empCo);depOpts.push({id:'home',name:'Domicile',km:rA.km,min:+rA.min,hasCoords:true});arrOpts.push({id:'home',name:'Domicile',km:rR.km,min:+rR.min,hasCoords:true})}catch(e){depOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:true});arrOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:true})}}else{depOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:false});arrOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:false})}// Depots
for(const dep of(data.depots||[])){const dc=dep._coords?parseCoords(typeof dep._coords==='string'?dep._coords:dep._coords.join(',')):null;if(dc){try{const rA=await osmRoute(dc,co);const rR=await osmRoute(co,dc);depOpts.push({id:dep.id,name:dep.name,km:rA.km,min:+rA.min,hasCoords:true});arrOpts.push({id:dep.id,name:dep.name,km:rR.km,min:+rR.min,hasCoords:true})}catch(e){depOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:true});arrOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:true})}}else{depOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:false});arrOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:false})}}setDepartOpts(depOpts);setArriveeOpts(arrOpts);setRouteCalcing(false)},[gps,empId,data.depots,data.employees]);
useEffect(()=>{if(routeTimer.current)clearTimeout(routeTimer.current);routeTimer.current=setTimeout(()=>{if(gps&&empId)calcAllRoutes()},500);return()=>{if(routeTimer.current)clearTimeout(routeTimer.current)}},[gps,empId,calcAllRoutes]);
const shortestDep=useMemo(()=>{const valid=departOpts.filter(o=>o.hasCoords&&o.km>0);return valid.length>0?valid.reduce((mn,o)=>o.km<mn.km?o:mn,valid[0]):null},[departOpts]);
const shortestArr=useMemo(()=>{const valid=arriveeOpts.filter(o=>o.hasCoords&&o.km>0);return valid.length>0?valid.reduce((mn,o)=>o.km<mn.km?o:mn,valid[0]):null},[arriveeOpts]);
const selDep=departOpts.find(o=>o.id===startFrom);
const selArr=arriveeOpts.find(o=>o.id===endAt);
const kmA=selDep?selDep.km:0;const minA=selDep?selDep.min:0;
const kmR=selArr?selArr.km:0;const minR=selArr?selArr.min:0;
const forfaits=mach&&mach.type==='Citerne'?['Demi-journee','Journee']:['2h','4h','6h','8h'];
const handleSave=()=>{let nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];let cId=clientId;if(newClient&&!clientId){const nc={id:uid(),name:newClient,forfaitType:'standard',agencies:[],siteManagers:[]};if(!nd.clients)nd.clients=[];nd.clients.push(nc);cId=nc.id}if(siteMgr&&cId){const cl=(nd.clients||[]).find(c=>c.id===cId);if(cl&&!(cl.siteManagers||[]).find(s=>s.name===siteMgr)){if(!cl.siteManagers)cl.siteManagers=[];cl.siteManagers.push({name:siteMgr,phone:siteMgrPh})}}const jb={id:job?job.id:uid(),date:dateStr,employeeId:empId,machineId:machId,clientId:cId,agencyName:agency,siteManager:siteMgr,siteManagerPhone:siteMgrPh,location,gps,forfaitType:forfait,citOption:mach&&mach.type==='Citerne'?citOpt:undefined,priceForfait:Number(price),isNight,hasTransfer,transferPrice:Number(transferPr),billingStart:billStart,startFrom,endAt,machineFuelL:Number(fuelL),machineFuelDepot:fuelDepot,kmAller:kmA,kmRetour:kmR,travelMinAller:minA,travelMinRetour:minR,distanceKm:kmA+kmR,travelMin:minA+minR,sent:job?job.sent:false};const idx=nd.jobs.findIndex(j=>j.id===jb.id);if(idx>=0)nd.jobs[idx]=jb;else nd.jobs.push(jb);save(nd);onClose()};
const selField=(label,val,setVal,opts,ph)=>(<Fl label={label}><select style={inputStyle} value={val} onChange={e=>setVal(e.target.value)}><option value="">{ph||'--'}</option>{opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select></Fl>);
const RouteCard=({opt,selected,isShortest,onClick})=>{const noGps=!opt.hasCoords;const noData=opt.hasCoords&&opt.km===0&&!parseCoords(gps);const isSel=selected;const isShort=!isSel&&isShortest;const bdr=isSel?'2px solid #008965':isShort?'2px solid #16a34a':noGps?'2px solid #e2e8f0':'2px solid '+C.border;const bg=isSel?'#00896508':isShort?'#16a34a08':noGps?'#f1f5f9':'transparent';const clr=isSel?'#008965':isShort?'#16a34a':noGps?C.muted:C.dim;return(<div onClick={noGps?undefined:onClick} style={{border:bdr,background:bg,borderRadius:8,padding:'8px 12px',cursor:noGps?'not-allowed':'pointer',textAlign:'center',minWidth:90,opacity:noGps?0.5:1,flex:'1 1 auto'}}><div style={{fontSize:13,fontWeight:500,color:clr}}>{opt.name}</div>{noGps?<div style={{fontSize:9,color:C.muted}}>Pas de GPS</div>:!parseCoords(gps)?<div style={{fontSize:16,fontWeight:500,color:clr}}>— km</div>:<React.Fragment><div style={{fontSize:16,fontWeight:700,color:clr}}>{opt.km} km</div><div style={{fontSize:9,color:clr}}>{fmtDuration(opt.min)}</div></React.Fragment>}</div>)};
const depName=startFrom==='home'?'Domicile':(data.depots||[]).find(d=>d.id===startFrom)?.name||'?';
const arrName=endAt==='home'?'Domicile':(data.depots||[]).find(d=>d.id===endAt)?.name||'?';
return(
<Mod title={job?'Modifier mission':'Nouvelle mission'} onClose={onClose} width={540}>
<Fl label="Client"><select style={inputStyle} value={clientId} onChange={e=>{setClientId(e.target.value);setNewClient('')}}><option value="">-- Choisir --</option>{(data.clients||[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{!clientId&&<input style={{...inputStyle,marginTop:4}} placeholder="Nouveau client" value={newClient} onChange={e=>setNewClient(e.target.value)}/>}</Fl>
{client&&(client.agencies||[]).length>0&&selField('Agence',agency,setAgency,(client.agencies||[]).map(a=>({v:a,l:a})))}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Chef chantier"><input list="sm-dl" style={inputStyle} value={siteMgr} onChange={e=>setSiteMgr(e.target.value)}/><datalist id="sm-dl">{(client&&client.siteManagers||[]).map((s,i)=><option key={i} value={s.name}/>)}</datalist></Fl>
<Fl label="Tel chef"><input style={inputStyle} value={siteMgrPh} onChange={e=>setSiteMgrPh(e.target.value)}/></Fl>
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
{selField('Chauffeur',empId,setEmpId,(data.employees||[]).map(e=>({v:e.id,l:e.name})),'Choisir')}
{selField('Machine',machId,setMachId,machines.map(m=>({v:m.id,l:m.name+' ('+m.type+')'})),'Choisir')}
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Debut facturation"><input type="time" style={inputStyle} value={billStart} onChange={e=>setBillStart(e.target.value)}/></Fl>
<Fl label="Date"><input type="date" style={inputStyle} value={dateStr} disabled/></Fl>
</div>
<Fl label="Lieu du chantier"><input style={inputStyle} value={location} onChange={e=>{setLocation(e.target.value);doAddr(e.target.value)}}/>{addrRes.length>0&&<div style={{border:'1px solid '+C.border,borderRadius:6,maxHeight:120,overflow:'auto',background:'#fff'}}>{addrRes.map((r,i)=><div key={i} style={{padding:'4px 8px',cursor:'pointer',fontSize:12,borderBottom:'1px solid #f1f5f9'}} onClick={()=>{setLocation(r.display_name);setGps(r.lat+','+r.lon);setAddrRes([])}}>{r.display_name}</div>)}</div>}<input style={{...inputStyle,marginTop:4,fontSize:11}} value={gps} onChange={e=>setGps(e.target.value)} placeholder="GPS (lat,lon)"/></Fl>
<Fl label="Forfait"><div style={{display:'flex',gap:4,flexWrap:'wrap',alignItems:'center'}}>{forfaits.map(f=><button key={f} onClick={()=>setForfait(f)} style={{...btnStyle(FC[f]||C.accent,forfait===f),padding:'4px 10px',fontSize:12}}>{f}</button>)}<label style={{display:'flex',gap:4,fontSize:12,cursor:'pointer',marginLeft:8}}><input type="checkbox" checked={hasTransfer} onChange={e=>setHasTransfer(e.target.checked)}/>+Transfert</label></div></Fl>
{mach&&mach.type==='Citerne'&&<Fl label="Option citerne"><div style={{display:'flex',gap:8}}>{['Avec chauffeur','Sans chauffeur'].map(o=><label key={o} style={{display:'flex',gap:4,fontSize:13,cursor:'pointer'}}><input type="radio" name="citOpt" checked={citOpt===o} onChange={()=>setCitOpt(o)}/>{o}</label>)}</div></Fl>}
<label style={{display:'flex',gap:4,fontSize:13,cursor:'pointer',marginBottom:12}}><input type="checkbox" checked={isNight} onChange={e=>setIsNight(e.target.checked)}/>Nuit (+{data.nightPct||30}%)</label>
<Fl label={'Depart vers chantier'+(routeCalcing?' ⏳':'')}>
{departOpts.length>0?<div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{departOpts.map(o=><RouteCard key={o.id} opt={o} selected={startFrom===o.id} isShortest={shortestDep&&shortestDep.id===o.id} onClick={()=>setStartFrom(o.id)}/>)}</div>:<div style={{fontSize:12,color:C.muted}}>Selectionnez un chauffeur et renseignez le GPS du chantier</div>}
</Fl>
<Fl label={'Arrivee depuis chantier'+(routeCalcing?' ⏳':'')}>
{arriveeOpts.length>0?<div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{arriveeOpts.map(o=><RouteCard key={o.id} opt={o} selected={endAt===o.id} isShortest={shortestArr&&shortestArr.id===o.id} onClick={()=>setEndAt(o.id)}/>)}</div>:<div style={{fontSize:12,color:C.muted}}>Selectionnez un chauffeur et renseignez le GPS du chantier</div>}
</Fl>
{startFrom&&endAt&&(kmA>0||kmR>0)&&<div style={{background:'#00896508',border:'1px solid #00896520',borderRadius:8,padding:'8px 12px',marginBottom:12,fontSize:13}}>
<div style={{color:'#0891b2'}}>Aller : {depName} → Chantier = <b>{kmA}km</b> ({fmtDuration(minA)})</div>
<div style={{color:'#7c3aed'}}>Retour : Chantier → {arrName} = <b>{kmR}km</b> ({fmtDuration(minR)})</div>
<div style={{textAlign:'right',color:C.accent,fontWeight:700,marginTop:2}}>Total : {(kmA+kmR).toFixed(1)}km ({fmtDuration(minA+minR)})</div>
</div>}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Prix forfait"><input type="number" style={inputStyle} value={price} onChange={e=>setPrice(e.target.value)}/></Fl>
{hasTransfer&&<Fl label="Prix transfert"><input type="number" style={inputStyle} value={transferPr} onChange={e=>setTransferPr(e.target.value)}/></Fl>}
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Conso machine (L)"><input type="number" style={inputStyle} value={fuelL} onChange={e=>setFuelL(e.target.value)}/></Fl>
{selField('Depot carburant',fuelDepot,setFuelDepot,(data.depots||[]).map(d=>({v:d.id,l:d.name})))}
</div>
<div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
<button onClick={onClose} style={btnStyle(C.dim)}>Annuler</button>
{job&&<button onClick={()=>{if(!confirm('Supprimer cette mission ?'))return;const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(j=>j.id!==job.id);save(nd);onClose()}} style={btnStyle(C.red)}>Supprimer</button>}
<button onClick={handleSave} style={btnStyle(C.accent,true)}>Enregistrer</button>
</div></Mod>);};

// ======== MISSION DETAIL ========
const MissionDetail=({data,save,job,onBack,onEdit})=>{
const client=(data.clients||[]).find(c=>c.id===job.clientId);
const mach=(data.machines||[]).find(m=>m.id===job.machineId);
const emp=(data.employees||[]).find(e=>e.id===job.employeeId);
const ft=getMachineFuelType(data,job.machineId);
const fp=getFuelPrice(data,ft,job.machineFuelDepot);
const truck=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);
const truckCons=truck?Number(truck.fuelPer100)||25:25;
const travelFuelL=((job.distanceKm||0)/100)*truckCons;
const travelFuelCost=travelFuelL*getFuelPrice(data,'gazole',job.startFrom!=='home'?job.startFrom:null);
const machineFuelCost=(job.machineFuelL||0)*fp;
const salaryCost=((job.travelMin||0)/60)*(emp?Number(emp.hourlySalary)||12:12);
const totalCost=salaryCost+travelFuelCost;
const toggleSent=()=>{const nd=JSON.parse(JSON.stringify(data));const j=nd.jobs.find(x=>x.id===job.id);if(j){j.sent=!j.sent;save(nd)}};
const row=(l,v,c)=>(<div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}><span style={{color:C.dim}}>{l}</span><span style={{fontWeight:600,color:c||C.text}}>{v}</span></div>);
const card=(ch,st)=>(<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,...st}}>{ch}</div>);
return(
<div style={{maxWidth:700,margin:'0 auto'}}>
<button onClick={onBack} style={{...btnStyle(C.accent),marginBottom:12,fontSize:13}}>{'< Retour'}</button>
{card(<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
<div><div style={{fontSize:16,fontWeight:700}}>{client?client.name:'Client'} {job.agencyName?'- '+job.agencyName:''}</div>
<div style={{fontSize:20,fontWeight:800,color:C.accent}}>{fmtMoney((job.priceForfait||0)+(job.hasTransfer?job.transferPrice||0:0))}</div></div>
<div style={{display:'flex',gap:6,alignItems:'center'}}>{mach&&<Bg text={mach.name} color={MC[mach.type]||C.accent}/>}<button onClick={()=>onEdit(job)} style={btnStyle(C.accent)}>Modifier</button></div>
</div>
{job.siteManager&&<div style={{fontSize:13,marginBottom:4}}>Chef: {job.siteManager} {job.siteManagerPhone&&<a href={'tel:'+job.siteManagerPhone} style={{color:C.accent}}>{job.siteManagerPhone}</a>}</div>}
{job.location&&<div style={{fontSize:13,color:C.dim,marginBottom:4}}>{job.location}</div>}
{job.gps&&<div style={{marginBottom:4}}><a href={'https://www.google.com/maps?q='+job.gps} target="_blank" rel="noopener" style={{fontSize:12,color:C.accent}}>Voir sur Google Maps</a></div>}
<div style={{fontSize:13,color:C.dim}}>Debut: {job.billingStart} | Forfait: {job.forfaitType} {job.hasTransfer?'+T':''} | {(job.distanceKm||0).toFixed(1)} km</div>
</div>)}
{(job.kmAller>0||job.kmRetour>0)&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginTop:10}}>
{card(<div><div style={{fontSize:12,fontWeight:700,color:C.cyan,marginBottom:6}}>Aller</div>{row('Distance',(job.kmAller||0).toFixed(1)+' km')}{row('Duree',fmtDuration(job.travelMinAller||0))}</div>,{borderTop:'3px solid '+C.cyan})}
{card(<div><div style={{fontSize:12,fontWeight:700,color:'#8b5cf6',marginBottom:6}}>Retour</div>{row('Distance',(job.kmRetour||0).toFixed(1)+' km')}{row('Duree',fmtDuration(job.travelMinRetour||0))}</div>,{borderTop:'3px solid #8b5cf6'})}
</div>}
{job.hasTransfer&&card(<div><div style={{fontSize:12,fontWeight:700,color:C.orange,marginBottom:8}}>Cout transfert</div>{row('Salaire chauffeur',fmtMoney(salaryCost))}{row('Carburant',fmtMoney(travelFuelCost))}{row('Cout total',fmtMoney(totalCost),C.red)}{row('Facture',fmtMoney(job.transferPrice),C.accent)}{row('Marge',fmtMoney(job.transferPrice-totalCost),(job.transferPrice-totalCost)>=0?C.green:C.red)}</div>,{borderTop:'3px solid '+C.orange,marginTop:10})}
{card(<div><div style={{fontSize:12,fontWeight:700,color:C.dim,marginBottom:8}}>Carburant</div>{row('Trajet',travelFuelL.toFixed(1)+' L | '+fmtMoney(travelFuelCost)+' | '+(ft==='gazole'?'Gazole':'GNR'))}{job.machineFuelL>0&&row('Machine chantier',job.machineFuelL+' L | '+fmtMoney(machineFuelCost)+' | '+(ft==='gazole'?'Gazole':'GNR'))}</div>,{marginTop:10})}
{(()=>{const te=(data.timeEntries||[]).filter(t=>t.empId===job.employeeId&&t.date===job.date);const mainTE=te.find(t=>t.startTime&&t.endTime);const pMinDetail=mainTE?(mainTE.pauseMin||0):0;const theo=calcTheoreticalTimes(job,data,pMinDetail);if(!theo)return null;const tol=theo.tolerance;const hourly=emp?Number(emp.hourlySalary)||0:0;let deltaStartTxt='--',deltaEndTxt='--',overtimeMinE=0,overtimeMinD=0;if(mainTE&&mainTE.startTime){const[ash,asm]=mainTE.startTime.split(':').map(Number);const dS=(ash*60+asm)-theo.theoStartMin;deltaStartTxt=dS>0?'+'+dS+'min (retard)':dS<0?dS+'min (avance)':'0min';if(dS<0)overtimeMinE=Math.abs(dS)}if(mainTE&&mainTE.endTime){const[aeh,aem]=mainTE.endTime.split(':').map(Number);const dE=(aeh*60+aem)-theo.theoEndMin;deltaEndTxt=dE>0?'+'+dE+'min (depassement)':dE<0?dE+'min (avance)':'0min';if(dE>0)overtimeMinD=dE}const overtimeMin=overtimeMinE+overtimeMinD;const overtimeCost=overtimeMin*(hourly/60);return card(
<div>
<div style={{fontSize:12,fontWeight:700,color:C.orange,marginBottom:8}}>Analyse des heures</div>
{row('Theo. embauche',theo.theoStart)}
{mainTE&&mainTE.startTime&&row('Reelle embauche',mainTE.startTime)}
{row('Delta embauche',deltaStartTxt,deltaStartTxt.includes('retard')?C.red:deltaStartTxt.includes('avance')?C.orange:C.green)}
{row('Theo. debauche',theo.theoEnd)}
{mainTE&&mainTE.endTime&&row('Reelle debauche',mainTE.endTime)}
{row('Delta debauche',deltaEndTxt,deltaEndTxt.includes('depassement')?C.red:C.green)}
{overtimeMinE>0&&row('Surcout embauche tot (+'+overtimeMinE+'min)',fmtMoney(overtimeMinE*(hourly/60)),C.orange)}
{overtimeMinD>0&&row('Surcout debauche tard (+'+overtimeMinD+'min)',fmtMoney(overtimeMinD*(hourly/60)),C.red)}
{(overtimeMinE+overtimeMinD)>0&&row('Surcout total ('+(overtimeMinE+overtimeMinD)+'min)',fmtMoney(overtimeCost),C.red)}
</div>,{borderTop:'3px solid '+C.orange,marginTop:10})})()}
<div style={{marginTop:12,textAlign:'center'}}><button onClick={toggleSent} style={btnStyle(job.sent?C.green:C.accent,true)}>{job.sent?'Envoye':'Envoyer'}</button></div>
</div>);};

// ======== PLANNING PAGE ========
const DEPOT_ACTIVITIES=['Rangement / nettoyage','Mecanique / entretien','Attente pieces','Formation','Administratif','Autre'];
const PlanningPage=({data,save})=>{
const[selDate,setSelDate]=useState(fmtDateISO(new Date()));
const[viewDetail,setViewDetail]=useState(null);
const[showForm,setShowForm]=useState(false);
const[formJob,setFormJob]=useState(null);
const[formEmpId,setFormEmpId]=useState('');
const[showDepotForm,setShowDepotForm]=useState(false);const[openDetails,setOpenDetails]=useState({});
const[dragId,setDragId]=useState(null);const[dragOverId,setDragOverId]=useState(null);
const[depotFormEmpId,setDepotFormEmpId]=useState('');
const[depotFormDepotId,setDepotFormDepotId]=useState('');
const[depotFormActivity,setDepotFormActivity]=useState(DEPOT_ACTIVITIES[0]);
const[depotFormDesc,setDepotFormDesc]=useState('');
const dayJobs=useMemo(()=>(data.jobs||[]).filter(j=>j.date===selDate),[data.jobs,selDate]);
const dayMissions=useMemo(()=>dayJobs.filter(j=>j.type!=='depot'),[dayJobs]);
const detailJob=viewDetail?dayJobs.find(j=>j.id===viewDetail)||(data.jobs||[]).find(j=>j.id===viewDetail):null;
const navDate=d=>{const dt=new Date(selDate);dt.setDate(dt.getDate()+d);setSelDate(fmtDateISO(dt))};
const caTotal=dayMissions.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const withJobs=[...new Set(dayJobs.map(j=>j.employeeId))];
const availDrivers=(data.employees||[]).filter(e=>!withJobs.includes(e.id));
const saveDepotJob=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:depotFormEmpId,type:'depot',depotId:depotFormDepotId,depotActivity:depotFormActivity,depotDescription:depotFormDesc});save(nd);setShowDepotForm(false);setDepotFormEmpId('');setDepotFormDepotId('');setDepotFormActivity(DEPOT_ACTIVITIES[0]);setDepotFormDesc('')};
if(detailJob&&detailJob.type!=='depot')return(<MissionDetail data={data} save={save} job={detailJob} onBack={()=>setViewDetail(null)} onEdit={j=>{setFormJob(j);setShowForm(true)}}/>);
const yearStart=data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1));
const wdpm=data.workDaysPerMonth||22;
const toggleDetail=id=>setOpenDetails(p=>({...p,[id]:!p[id]}));
const getMach=id=>(data.machines||[]).find(m=>m.id===id);
const getClient=id=>(data.clients||[]).find(c=>c.id===id);
const getDepot=id=>(data.depots||[]).find(d=>d.id===id);
const usedMachIds=dayMissions.map(j=>j.machineId);
const renderCol=(types,label)=>{
const allM=(data.machines||[]).filter(m=>types.includes(m.type));
const freeM=allM.filter(m=>!usedMachIds.includes(m.id));
const empIdsWithJobs=dayJobs.filter(j=>{const m=getMach(j.machineId);return m&&types.includes(m.type)}).map(j=>j.employeeId);
const defaultEmpIds=(data.employees||[]).filter(e=>{const m=getMach(e.machineId);if(!m||!types.includes(m.type))return false;const empDayJobs=dayJobs.filter(j=>j.employeeId===e.id&&j.type!=='depot');if(empDayJobs.length===0)return true;return empDayJobs.some(j=>{const jm=getMach(j.machineId);return jm&&types.includes(jm.type)})}).map(e=>e.id);
const empIdsRaw=[...new Set([...defaultEmpIds,...empIdsWithJobs])];
const orderKey=selDate+'_'+types.join(',');
const savedOrder=(data.cardOrder||{})[orderKey]||[];
const empIds=[...empIdsRaw].sort((a,b)=>{const ia=savedOrder.indexOf(a);const ib=savedOrder.indexOf(b);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return-1;return ia-ib});
const assignedMachIds=new Set((data.employees||[]).map(e=>e.machineId).filter(Boolean));
const driverBusyOnOtherMach=new Set();
(data.employees||[]).forEach(emp2=>{if(emp2.machineId){const empJobs=dayJobs.filter(j=>j.employeeId===emp2.id&&j.type!=='depot');const hasJobOnOther=empJobs.some(j=>j.machineId&&j.machineId!==emp2.machineId);if(hasJobOnOther&&!empJobs.some(j=>j.machineId===emp2.machineId)){driverBusyOnOtherMach.add(emp2.machineId)}}});
const unassignedM=allM.filter(m=>!assignedMachIds.has(m.id)||driverBusyOnOtherMach.has(m.id));
const unassignedOrder=(data.cardOrder||{})[orderKey+'_u']||[];
const allCardIds=[...empIds.map(id=>'e_'+id),...unassignedM.map(m=>'m_'+m.id)];
const savedAllOrder=(data.cardOrder||{})[orderKey+'_all']||[];
const sortedCards=allCardIds.sort((a,b)=>{const ia=savedAllOrder.indexOf(a);const ib=savedAllOrder.indexOf(b);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return-1;return ia-ib});
const onDragStart=(e,cardId)=>{setDragId(cardId);e.dataTransfer.effectAllowed='move'};
const onDragOver=(e,cardId)=>{e.preventDefault();if(cardId!==dragId)setDragOverId(cardId)};
const onDragEnd=()=>{if(dragId&&dragOverId&&dragId!==dragOverId){const newOrder=[...sortedCards];const fromIdx=newOrder.indexOf(dragId);const toIdx=newOrder.indexOf(dragOverId);if(fromIdx>=0&&toIdx>=0){newOrder.splice(fromIdx,1);newOrder.splice(toIdx,0,dragId);const nd=JSON.parse(JSON.stringify(data));if(!nd.cardOrder)nd.cardOrder={};nd.cardOrder[orderKey+'_all']=newOrder;save(nd)}}setDragId(null);setDragOverId(null)};
return(
<div>
<div style={{background:C.card,borderRadius:8,padding:'10px 14px',marginBottom:10,marginTop:10,border:'1px solid '+C.border}}>
<span style={{color:MC[types[0]]||C.green,fontWeight:800,fontSize:18}}>{label}</span>
</div>
{(()=>{let shownSeparator=false;return sortedCards.map(cardId=>{
const showSep=!shownSeparator&&cardId.startsWith('m_');
if(showSep)shownSeparator=true;
if(cardId.startsWith('m_')){
const mId=cardId.slice(2);const um=allM.find(x=>x.id===mId);if(!um)return null;
const umHasJobWithDriver=dayJobs.some(j2=>j2.machineId===um.id&&j2.employeeId&&j2.type!=='depot');
if(umHasJobWithDriver)return null;
if(assignedMachIds.has(um.id)&&!driverBusyOnOtherMach.has(um.id))return null;
const umColor=MC[um.type]||C.accent;
const umJobs=dayJobs.filter(j2=>j2.machineId===um.id);
if(umJobs.length===0){
const createUmJob=(field,value)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const newJ={id:uid(),date:selDate,employeeId:'',machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false};newJ[field]=value;nd.jobs.push(newJ);save(nd)};
return(<React.Fragment key={cardId}>{showSep&&<div style={{borderTop:'3px dashed #cbd5e1',margin:'20px 0 12px',position:'relative'}}><span style={{position:'absolute',top:-10,left:12,background:'#cbd5e120',padding:'0 8px',fontSize:11,color:C.dim,fontWeight:600,borderRadius:4}}>Machines sans chauffeur</span></div>}<div draggable onDragStart={e=>onDragStart(e,cardId)} onDragOver={e=>onDragOver(e,cardId)} onDragEnd={onDragEnd} style={{background:C.card,borderRadius:8,marginBottom:8,border:'1px solid '+(dragOverId===cardId?C.accent:C.border),borderLeft:'4px solid '+umColor,padding:'6px 12px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap',opacity:dragId===cardId?0.5:1,cursor:'grab'}}>
<select style={{fontSize:13,fontWeight:700,border:'1px solid '+C.border,borderRadius:4,padding:'2px 4px',background:'#fff',minWidth:70,maxWidth:100}} value="" onChange={e2=>{if(!e2.target.value)return;const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:e2.target.value,machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}}><option value="">Chauff.</option>{(data.employees||[]).map(e2=><option key={e2.id} value={e2.id}>{e2.name}</option>)}</select>
<span style={{fontSize:15,fontWeight:800,color:umColor}}>· {um.name}{um.width?' ('+um.width+')':''}</span>
<select value="" onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau client:');if(n){const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:n,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);const nd2={...nd};if(!nd2.jobs)nd2.jobs=[];nd2.jobs.push({id:uid(),date:selDate,employeeId:'',machineId:um.id,clientId:nc.id,agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd2)}}else if(e.target.value){createUmJob('clientId',e.target.value)}}} style={{fontSize:13,padding:'2px 4px',borderRadius:4,border:'1px solid '+C.border,background:'#fff',minWidth:90,maxWidth:130}}>
<option value="">Client</option>{(data.clients||[]).map(c2=><option key={c2.id} value={c2.id}>{c2.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<input placeholder="Lieu" onKeyDown={e=>{if(e.key==='Enter'&&e.target.value){createUmJob('location',e.target.value);e.target.value=''}}} style={{fontSize:13,padding:'2px 6px',borderRadius:4,border:'1px solid '+C.border,minWidth:80,maxWidth:140,background:'#fff'}}/>
<button onClick={()=>{setDepotFormEmpId('');setShowDepotForm(true)}} style={{background:'#64748b',color:'#fff',border:'none',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:12}}>Depot</button>
</div></React.Fragment>)}
return(<React.Fragment key={cardId}>{showSep&&<div style={{borderTop:'3px dashed #cbd5e1',margin:'20px 0 12px',position:'relative'}}><span style={{position:'absolute',top:-10,left:12,background:'#f1f5f9',padding:'0 8px',fontSize:11,color:C.dim,fontWeight:600,borderRadius:4}}>Machines disponibles</span></div>}<div draggable onDragStart={e=>onDragStart(e,cardId)} onDragOver={e=>onDragOver(e,cardId)} onDragEnd={onDragEnd} style={{background:C.card,borderRadius:10,marginBottom:12,border:'2px solid '+(dragOverId===cardId?C.accent+'80':umColor+'40'),borderLeft:'6px solid '+umColor,overflow:'hidden',boxShadow:'0 2px 6px rgba(0,0,0,.06)',display:'flex',opacity:dragId===cardId?0.5:1,cursor:'grab'}}>
<div style={{width:100,minWidth:100,maxWidth:100,padding:'10px 6px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:'2px solid '+umColor+'20',background:umColor+'08',gap:4}}>
<select style={{fontSize:13,fontWeight:700,border:'1px solid '+C.border,borderRadius:6,padding:'3px 4px',background:'#fff',width:'100%',textAlign:'center'}} value="" onChange={e2=>{if(!e2.target.value)return;const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const existingJ=nd.jobs.filter(x=>x.machineId===um.id&&x.date===selDate);if(existingJ.length>0){existingJ.forEach(x2=>{x2.employeeId=e2.target.value})}else{nd.jobs.push({id:uid(),date:selDate,employeeId:e2.target.value,machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false})}save(nd)}}><option value="">Chauff.</option>{(data.employees||[]).map(e2=><option key={e2.id} value={e2.id}>{e2.name}</option>)}</select>
<div style={{fontSize:13,fontWeight:700,color:umColor,textAlign:'center'}}>{um.name}{um.width?' ('+um.width+')':''}</div>
<button onClick={e=>{e.stopPropagation();const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:'',machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}} style={{background:C.accent,color:'#fff',border:'none',borderRadius:4,width:22,height:22,cursor:'pointer',fontSize:14,fontWeight:700,lineHeight:'20px',padding:0}}>+</button>
</div>
<div style={{flex:1,minWidth:0}}>
{umJobs.map(uj=>{const ujCl=getClient(uj.clientId);const ujM=um;const ujMt=um.type;return(
<div key={uj.id} style={{borderBottom:'1px solid '+C.border,background:uj.ack?'#dcfce7':C.card}}>
<div style={{padding:'6px 10px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
<select value={uj.clientId||''} onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau client:');if(n){const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:n,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);const jj=nd.jobs.find(x=>x.id===uj.id);if(jj)jj.clientId=nc.id;save(nd)}}else{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.clientId=e.target.value;if(ujM&&jj.forfaitType){const p=getForfaitPrice(nd,e.target.value,ujM,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:100,maxWidth:150}}>
<option value="">Client</option>{(data.clients||[]).map(c2=><option key={c2.id} value={c2.id}>{c2.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<select value={uj.siteManager||''} onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau chef:');if(n){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.siteManager=n;const cl2=(nd.clients||[]).find(c2=>c2.id===uj.clientId);if(cl2){if(!cl2.siteManagers)cl2.siteManagers=[];if(!cl2.siteManagers.find(s=>s.name===n)){const ph=prompt('Tel (optionnel):','')||'';cl2.siteManagers.push({name:n,phone:ph});jj.siteManagerPhone=ph}}save(nd)}}}else{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.siteManager=e.target.value;const cl2=(data.clients||[]).find(c2=>c2.id===uj.clientId);const sm=(cl2&&cl2.siteManagers||[]).find(s=>s.name===e.target.value);if(sm)jj.siteManagerPhone=sm.phone||'';save(nd)}}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:80,maxWidth:130}}>
<option value="">Chef</option>{(ujCl&&ujCl.siteManagers||[]).map((s,si)=><option key={si} value={s.name}>{s.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<input value={uj.location||''} placeholder="Lieu / adresse" onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.location=e.target.value;save(nd)}}} style={{fontSize:15,padding:'4px 8px',borderRadius:6,border:'1px solid '+C.border,minWidth:100,flex:1,maxWidth:220,background:'#fff'}}/>
<input type="time" value={uj.billingStart||'08:00'} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.billingStart=e.target.value;save(nd)}}} style={{fontSize:15,padding:'4px 4px',borderRadius:6,border:'2px solid '+C.orange+'40',background:C.orange+'08',color:C.orange,fontWeight:700,width:75}}/>
<input value={uj.gps||''} placeholder="GPS lat,lon" onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.gps=e.target.value;save(nd)}}} style={{fontSize:12,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,width:110,background:'#fff',color:C.dim}}/>
{(()=>{const gpsJ=parseCoords(uj.gps);const empCo2=uj.employeeId?getEmpCoords(data,uj.employeeId):null;const depOptions2=[{id:'home',name:'Dom.',co:empCo2},...(data.depots||[]).map(d2=>({id:d2.id,name:d2.name,co:d2._coords?parseCoords(typeof d2._coords==='string'?d2._coords:d2._coords.join(',')):null}))].map(o=>({...o,km:o.co&&gpsJ?+(haversine(o.co,gpsJ)*1.3).toFixed(0):null}));const arrOptions2=depOptions2.map(o=>({...o,km:o.co&&gpsJ?+(haversine(gpsJ,o.co)*1.3).toFixed(0):null}));const validDep=depOptions2.filter(o=>o.km!==null);const validArr=arrOptions2.filter(o=>o.km!==null);const shortDep=validDep.length>0?validDep.reduce((mn,o)=>o.km<mn.km?o:mn,validDep[0]):null;const shortArr=validArr.length>0?validArr.reduce((mn,o)=>o.km<mn.km?o:mn,validArr[0]):null;
if(gpsJ&&!uj.startFrom&&shortDep){setTimeout(()=>{const nd2=JSON.parse(JSON.stringify(data));const jj2=nd2.jobs.find(x=>x.id===uj.id);if(jj2&&!jj2.startFrom){jj2.startFrom=shortDep.id;jj2.kmAller=shortDep.km;if(!jj2.endAt&&shortArr){jj2.endAt=shortArr.id;jj2.kmRetour=shortArr.km}jj2.distanceKm=(jj2.kmAller||0)+(jj2.kmRetour||0);save(nd2)}},0)}
return(<React.Fragment>
<select value={uj.startFrom||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.startFrom=e.target.value;const sel2=depOptions2.find(o=>o.id===e.target.value);jj.kmAller=sel2&&sel2.km?sel2.km:0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 3px',borderRadius:4,border:'1px solid #0891b240',background:uj.startFrom&&shortDep&&uj.startFrom===shortDep.id?'#0891b218':'#0891b208',color:'#0891b2',fontWeight:600,minWidth:60,maxWidth:110}}>
<option value="">↗Dep</option>{depOptions2.map(o=><option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km':''}{shortDep&&o.id===shortDep.id?' ★':''}</option>)}
</select>
<select value={uj.endAt||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.endAt=e.target.value;const sel2=arrOptions2.find(o=>o.id===e.target.value);jj.kmRetour=sel2&&sel2.km?sel2.km:0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 3px',borderRadius:4,border:'1px solid #7c3aed40',background:uj.endAt&&shortArr&&uj.endAt===shortArr.id?'#7c3aed18':'#7c3aed08',color:'#7c3aed',fontWeight:600,minWidth:60,maxWidth:110}}>
<option value="">↙Arr.</option>{arrOptions2.map(o=><option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km':''}{shortArr&&o.id===shortArr.id?' ★':''}</option>)}
</select>
</React.Fragment>)})()}
<select value={uj.forfaitType||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj&&ujM){jj.forfaitType=e.target.value;const p=getForfaitPrice(nd,uj.clientId,ujM,e.target.value,uj.citOption,uj.isNight);if(p)jj.priceForfait=p;save(nd)}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'2px solid '+(uj.forfaitType?FC[uj.forfaitType]||C.accent:C.border),background:uj.forfaitType?(FC[uj.forfaitType]||C.accent)+'15':'#fff',color:uj.forfaitType?FC[uj.forfaitType]||C.accent:C.dim,fontWeight:uj.forfaitType?700:400,minWidth:40}}>
<option value="">F</option>{(ujMt==='Citerne'?['Demi-journee','Journee']:['2h','4h','6h','8h']).map(f=><option key={f} value={f}>{f}</option>)}
</select>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj&&ujM){jj.hasTransfer=!jj.hasTransfer;if(jj.hasTransfer&&!jj.transferPrice){const tp=getTransferPrice(nd,uj.clientId,ujM,uj.citOption,uj.isNight);jj.transferPrice=tp||0}save(nd)}}} style={{padding:'4px 8px',borderRadius:6,fontSize:14,border:'2px solid '+(uj.hasTransfer?C.purple:C.muted),background:uj.hasTransfer?C.purple+'20':'transparent',color:uj.hasTransfer?C.purple:C.dim,cursor:'pointer',fontWeight:uj.hasTransfer?700:400}}>{uj.hasTransfer?'T ✓':'+T'}</button>
<div style={{marginLeft:'auto',display:'flex',gap:4,alignItems:'center'}}>
<button onClick={()=>toggleDetail(uj.id)} style={{background:'none',border:'2px solid '+C.border,borderRadius:6,fontSize:14,cursor:'pointer',padding:'4px 8px',color:C.dim,fontWeight:600}}>{openDetails[uj.id]?'▲':'▼'}</button>
<button onClick={()=>{if(confirm('Supprimer ?')){const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(x=>x.id!==uj.id);save(nd)}}} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.red}}>×</button>
</div>
</div>
</div>)})}
</div>
</div></React.Fragment>)}
const eId=cardId.slice(2);
const emp=(data.employees||[]).find(e=>e.id===eId);if(!emp)return null;
const ejAll=dayJobs.filter(j=>j.employeeId===eId&&(j.type==='depot'||types.includes((getMach(j.machineId)||{}).type)));
const ej=ejAll.filter(j=>j.type!=='depot');
const depotJobs=ejAll.filter(j=>j.type==='depot');
const ca=ej.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const te=(data.timeEntries||[]).filter(t=>t.empId===eId&&t.date===selDate);
const hasJ=ejAll.length>0;
const hasMissions=ej.length>0;
let workMin=0,pauseMin=0,totalMinDay=0;
te.forEach(t=>{if(t.startTime&&t.endTime){const[sh,sm]=t.startTime.split(':').map(Number);const[eh,em]=t.endTime.split(':').map(Number);const total=(eh*60+em)-(sh*60+sm);workMin+=total-(t.pauseMin||0);pauseMin+=(t.pauseMin||0);totalMinDay+=total}});
const isMonthly=emp.salaryType==='monthly';
const hourly=isMonthly?0:Number(emp.hourlySalary)||0;
const dailySalary=isMonthly?(Number(emp.monthlySalary)||0)/wdpm:0;
const salTotal=isMonthly?dailySalary:(workMin/60*hourly);
const mainTE=te.find(t=>t.startTime&&t.endTime)||te.find(t=>t.startTime)||te[0];
const pMinGlobal=mainTE?(mainTE.pauseMin||0):0;
const firstJob=ej.length>0?ej.reduce((a,b)=>(a.billingStart||'99')<(b.billingStart||'99')?a:b):null;
const lastJob=ej.length>0?ej.reduce((a,b)=>(a.billingStart||'')<(b.billingStart||'')?b:a):null;
const theoFirst=firstJob?calcTheoreticalTimes(firstJob,data,pMinGlobal):null;
const theoLast=lastJob&&lastJob!==firstJob?calcTheoreticalTimes(lastJob,data,pMinGlobal):theoFirst;
const tolVal=theoFirst?theoFirst.tolerance:(data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES);
let startBadge=null,endBadge=null,overtimeMinEmb=0,overtimeMinDeb=0;
let surcoutEmb=0,surcoutDeb=0;
if(theoFirst&&mainTE&&mainTE.startTime){const[ash,asm]=mainTE.startTime.split(':').map(Number);const actualMin=ash*60+asm;const dS=actualMin-theoFirst.theoStartMin;if(Math.abs(dS)<=tolVal)startBadge={text:'Emb. OK',color:C.green};else if(dS<0){overtimeMinEmb=Math.abs(dS);surcoutEmb=(overtimeMinEmb/60)*hourly;startBadge={text:'Emb. +'+overtimeMinEmb+'min tot = '+fmtMoney(surcoutEmb),color:C.orange}}else startBadge={text:'Emb. '+dS+'min retard',color:C.red}}
if(theoLast&&mainTE&&mainTE.endTime){const[aeh,aem]=mainTE.endTime.split(':').map(Number);const actualMin=aeh*60+aem;const dE=actualMin-theoLast.theoEndMin;if(Math.abs(dE)<=tolVal)endBadge={text:'Deb. OK',color:C.green};else if(dE>0){overtimeMinDeb=dE;surcoutDeb=(overtimeMinDeb/60)*hourly;endBadge={text:'Deb. +'+overtimeMinDeb+'min tard = '+fmtMoney(surcoutDeb),color:C.red}}else endBadge={text:'Deb. '+Math.abs(dE)+'min tot',color:C.orange}}
let tempsDepotMin=0,coutDepot=0;
if(mainTE&&mainTE.startTime&&mainTE.endTime&&hasMissions){
const tempsChantiers=ej.reduce((s,j)=>s+forfaitHours(j.forfaitType)*60+(0),0);
const tempsPause=pauseMin;
const tempsRoute=ej.reduce((s,j)=>s+(Number(j.travelMinAller)||0)+(Number(j.travelMinRetour)||0),0);
const tpDep=(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const tpArr=(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const tempsExtra=(tpDep+tpArr)*ej.length;
tempsDepotMin=Math.max(0,totalMinDay-tempsChantiers-tempsPause-tempsRoute-tempsExtra);
coutDepot=(tempsDepotMin/60)*hourly}
if(!hasMissions&&workMin>0){tempsDepotMin=workMin;coutDepot=salTotal}
let totalCostsDay=0,totalRevDay=0;
const chargesRate=Number(emp.chargesRate)||45;
const mealAllowance=Number(emp.mealAllowance)||12;
const truck2g=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);
const jobCalcs=ej.map(j=>{const m=getMach(j.machineId);const mt=m?m.type:'';const fuelType=getMachineFuelType(data,j.machineId);const truck2=truck2g;const truckC=truck2?Number(truck2.fuelPer100)||25:25;const trajL=mt==='Raboteuse'?((j.distanceKm||0)/100)*truckC:(m?(Number(m.fuelConsumption)||0)*((j.travelMin||0)/60):0);const fuelPr=getFuelPrice(data,fuelType,j.startFrom!=='home'?j.startFrom:null);const trajCost=trajL*fuelPr;const machFuelPr=getFuelPrice(data,fuelType,j.machineFuelDepot);const machCost=(j.machineFuelL||0)*machFuelPr;const salRoute=((j.travelMin||0)/60)*hourly;const rev=(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0);const credM=m?(Number(m.creditMonthly)||0)/wdpm:0;const assM=m?((m.insuranceMonthly||0)/wdpm):0;const ctM=m?((m.ctCost||0)/12)/wdpm:0;const credT=truck2?(Number(truck2.creditMonthly)||0)/wdpm:0;const assT=truck2?((truck2.insuranceMonthly||0)/wdpm):0;const ctT=truck2?((truck2.ctCost||0)/12)/wdpm:0;const entretienMach=(data.interventions||[]).filter(ii=>ii.machineId===(m?m.id:'')&&ii.date>=yearStart&&ii.date<=selDate).reduce((s2,ii)=>s2+(ii.totalCost||0),0);const entretienCam=(data.interventions||[]).filter(ii=>truck2&&ii.truckId===truck2.id&&ii.date>=yearStart&&ii.date<=selDate).reduce((s2,ii)=>s2+(ii.totalCost||0),0);return{j,m,mt,fuelType,trajL,trajCost,machCost,salRoute,rev,cl:getClient(j.clientId),credM,assM,ctM,credT,assT,ctT,entretienMach,entretienCam}});
totalRevDay=jobCalcs.reduce((s,c)=>s+c.rev,0);
const totalSalRouteDay=jobCalcs.reduce((s,c)=>s+c.salRoute,0);
const salChantier=Math.max(0,salTotal-totalSalRouteDay);
const salTotalCharges=salTotal*(1+chargesRate/100);
jobCalcs.forEach(c=>{const ratio=totalRevDay>0?(c.rev/totalRevDay):0;const salChMission=salChantier*ratio;const surcDebMission=surcoutDeb*ratio;const fixesJour=c.credM+c.assM+c.ctM+c.credT+c.assT+c.ctT;c.salChMission=salChMission;c.surcMission=surcDebMission;c.fixesJour=fixesJour;c.fixesMach=c.credM+c.assM+c.ctM;c.fixesCam=c.credT+c.assT+c.ctT;c.salTotalMission=(salChMission+c.salRoute+surcDebMission)*(1+chargesRate/100)+mealAllowance*ratio;c.totalCost=c.trajCost+c.machCost+c.salTotalMission+fixesJour;c.benefBrut=c.rev-c.totalCost;c.revForfait=c.j.priceForfait||0;c.revTransfert=c.j.hasTransfer?c.j.transferPrice||0:0;c.coutsMachJour=c.machCost+c.fixesMach+(salChMission*(1+chargesRate/100))+(mealAllowance*ratio);c.coutsCamJour=c.trajCost+c.fixesCam+(c.salRoute*(1+chargesRate/100))});
totalCostsDay=jobCalcs.reduce((s,c)=>s+c.totalCost,0)+surcoutEmb*(1+chargesRate/100)+coutDepot*(1+chargesRate/100);
const benefDay=totalRevDay-totalCostsDay;
const dTotalEntretienMach=jobCalcs.reduce((s,c)=>s+c.entretienMach,0);
const dTotalEntretienCam=jobCalcs.length>0?jobCalcs[0].entretienCam:0;
const dTotalEntretien=dTotalEntretienMach+dTotalEntretienCam;
const dTotalSalaire=jobCalcs.reduce((s,c)=>s+c.salTotalMission,0)+surcoutEmb+coutDepot;
const dTotalCarbu=jobCalcs.reduce((s,c)=>s+c.trajCost+c.machCost,0);
const dTotalFixes=jobCalcs.reduce((s,c)=>s+c.fixesJour,0);
// --- MACHINE: remboursé par forfaits ---
const machIds=[...new Set(jobCalcs.map(c=>c.m?c.m.id:'').filter(Boolean))];
const allPastJobsMach=(data.jobs||[]).filter(j2=>j2.date>=yearStart&&j2.date<=selDate&&j2.type!=='depot'&&machIds.includes(j2.machineId));
const revMachCum=allPastJobsMach.reduce((s2,j2)=>s2+(j2.priceForfait||0),0);
const coutsMachCum=(()=>{let cm=0;allPastJobsMach.forEach(j2=>{const m2=getMach(j2.machineId);const emp2=(data.employees||[]).find(e=>e.id===j2.employeeId);const hr2=emp2?Number(emp2.hourlySalary)||0:0;const cr2=emp2?Number(emp2.chargesRate)||45:45;const ml2=emp2?Number(emp2.mealAllowance)||12:12;const fh2=forfaitHours(j2.forfaitType);const ft2=getMachineFuelType(data,j2.machineId);const fp2=getFuelPrice(data,ft2,j2.machineFuelDepot);cm+=(j2.machineFuelL||0)*fp2;if(m2){cm+=(Number(m2.creditMonthly)||0)/wdpm;cm+=(m2.insuranceMonthly||0)/wdpm;cm+=((m2.ctCost||0)/12)/wdpm}cm+=(fh2*hr2)*(1+cr2/100);cm+=ml2});return cm})();
const benefMachCum=revMachCum-coutsMachCum;
const resteMach=dTotalEntretienMach>0?Math.max(0,dTotalEntretienMach-Math.max(0,benefMachCum)):0;
const machRembourse=dTotalEntretienMach>0&&resteMach<=0;
const pctMach=dTotalEntretienMach>0?Math.min(100,(Math.max(0,benefMachCum)/dTotalEntretienMach)*100):100;
const benefMachAffiche=dTotalEntretienMach>0&&resteMach>0?0:Math.max(0,benefMachCum)-dTotalEntretienMach;
// --- CAMION: remboursé par transferts ---
const truckIdD=truck2g?truck2g.id:'';
const allPastJobsCam=(data.jobs||[]).filter(j2=>{if(j2.date<yearStart||j2.date>selDate||j2.type==='depot'||!j2.hasTransfer)return false;const m2=getMach(j2.machineId);if(!m2||m2.type!=='Raboteuse')return false;const e2=(data.employees||[]).find(e=>e.id===j2.employeeId);return e2&&e2.truckId===truckIdD});
const revCamCum=allPastJobsCam.reduce((s2,j2)=>s2+(j2.transferPrice||0),0);
const coutsCamCum=(()=>{let cc=0;const allTrJobs=(data.jobs||[]).filter(j2=>{if(j2.date<yearStart||j2.date>selDate||j2.type==='depot')return false;const m2=getMach(j2.machineId);if(!m2||m2.type!=='Raboteuse')return false;const e2=(data.employees||[]).find(e=>e.id===j2.employeeId);return e2&&e2.truckId===truckIdD});allTrJobs.forEach(j2=>{const emp2=(data.employees||[]).find(e=>e.id===j2.employeeId);const hr2=emp2?Number(emp2.hourlySalary)||0:0;const cr2=emp2?Number(emp2.chargesRate)||45:45;const ft2=getMachineFuelType(data,j2.machineId);const fp2=getFuelPrice(data,ft2,j2.startFrom!=='home'?j2.startFrom:null);const trC2=truck2g?Number(truck2g.fuelPer100)||25:25;const trajL2=((j2.distanceKm||0)/100)*trC2;cc+=trajL2*fp2;cc+=((j2.travelMin||0)/60)*hr2*(1+cr2/100)});if(truck2g){const daysUsed=[...new Set(allTrJobs.map(j2=>j2.date))].length||1;cc+=((Number(truck2g.creditMonthly)||0)/wdpm)*daysUsed;cc+=((truck2g.insuranceMonthly||0)/wdpm)*daysUsed;cc+=(((truck2g.ctCost||0)/12)/wdpm)*daysUsed}return cc})();
const benefCamCum=revCamCum-coutsCamCum;
const resteCam=dTotalEntretienCam>0?Math.max(0,dTotalEntretienCam-Math.max(0,benefCamCum)):0;
const camRembourse=dTotalEntretienCam>0&&resteCam<=0;
const pctCam=dTotalEntretienCam>0?Math.min(100,(Math.max(0,benefCamCum)/dTotalEntretienCam)*100):100;
const benefCamAffiche=dTotalEntretienCam>0&&resteCam>0?0:Math.max(0,benefCamCum)-dTotalEntretienCam;
// --- Bénéfice total chauffeur ---
const dBenefAffiche=(dTotalEntretienMach>0||dTotalEntretienCam>0)?(benefMachAffiche+benefCamAffiche):benefDay;
const dMarginPct=(totalRevDay>0)?((dBenefAffiche/totalRevDay)*100):0;
jobCalcs.forEach(c=>{c.marginPct=dMarginPct;c.benefAffiche=dBenefAffiche});
// Render each mission as a compact block
const allMissions=[...jobCalcs];
return(
<React.Fragment key={eId}>
{depotJobs.map(dj=>{const dep=getDepot(dj.depotId);return(
<div key={dj.id} style={{background:'#f8fafc',borderRadius:8,marginBottom:8,border:'1px solid '+C.border,borderLeft:'4px solid #64748b',padding:'8px 12px',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
<span style={{fontSize:15,fontWeight:700,color:'#64748b'}}>&#127959; {emp.name} — {dep?dep.name:'Depot'} — {dj.depotActivity||'Depot'}</span>
{dj.depotDescription&&<span style={{fontSize:14,color:C.dim}}>({dj.depotDescription})</span>}
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(x=>x.id!==dj.id);save(nd)}} style={{marginLeft:'auto',background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.red}}>x</button>
</div>)})}
{allMissions.length===0&&depotJobs.length===0&&(()=>{const defMach=getMach(emp.machineId);const machColor2=defMach?MC[defMach.type]||C.accent:C.muted;
const createJobForEmp=(field,value)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const newJ={id:uid(),date:selDate,employeeId:eId,machineId:emp.machineId||'',clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false};newJ[field]=value;nd.jobs.push(newJ);save(nd)};
return(
<div style={{background:C.card,borderRadius:8,marginBottom:8,border:'1px solid '+C.border,borderLeft:'4px solid '+machColor2,padding:'6px 12px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
<span style={{fontSize:15,fontWeight:800}}><span style={{color:C.text}}>{emp.name}</span>{defMach&&<span style={{color:machColor2}}> · {defMach.name}</span>}</span>
<select value="" onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau client:');if(n){const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:n,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);nd.jobs=[...(nd.jobs||[]),{id:uid(),date:selDate,employeeId:eId,machineId:emp.machineId||'',clientId:nc.id,agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false}];save(nd)}}else if(e.target.value){createJobForEmp('clientId',e.target.value)}}} style={{fontSize:13,padding:'2px 4px',borderRadius:4,border:'1px solid '+C.border,background:'#fff',minWidth:90,maxWidth:130}}>
<option value="">Client</option>{(data.clients||[]).map(c2=><option key={c2.id} value={c2.id}>{c2.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<input placeholder="Lieu" onKeyDown={e=>{if(e.key==='Enter'&&e.target.value){createJobForEmp('location',e.target.value);e.target.value=''}}} style={{fontSize:13,padding:'2px 6px',borderRadius:4,border:'1px solid '+C.border,minWidth:80,maxWidth:140,background:'#fff'}}/>
<button onClick={()=>{setDepotFormEmpId(eId);setShowDepotForm(true)}} style={{background:'#64748b',color:'#fff',border:'none',borderRadius:4,padding:'2px 8px',cursor:'pointer',fontSize:12}}>Depot</button>
</div>)})()}
{allMissions.length>0&&(()=>{const machGroups={};allMissions.forEach(mc=>{const mid=mc.m?mc.m.id:'none';if(!machGroups[mid])machGroups[mid]={m:mc.m,mt:mc.mt,missions:[]};machGroups[mid].missions.push(mc)});return Object.values(machGroups).map(grp=>{const machColor=MC[grp.mt]||C.accent;const allAck=grp.missions.every(mc2=>mc2.j.ack);return(
<div key={eId+'_'+(grp.m?grp.m.id:'none')} draggable onDragStart={e2=>onDragStart(e2,cardId)} onDragOver={e2=>onDragOver(e2,cardId)} onDragEnd={onDragEnd} style={{background:allAck?'#dcfce7':C.card,borderRadius:10,marginBottom:12,border:'2px solid '+(dragOverId===cardId?C.accent+'80':allAck?'#16a34a40':machColor+'40'),borderLeft:'6px solid '+(allAck?C.green:machColor),overflow:'hidden',boxShadow:'0 2px 6px rgba(0,0,0,.06)',display:'flex',opacity:dragId===cardId?0.5:1,cursor:'grab'}}>
{/* Côté gauche: nom + machine centré verticalement */}
<div style={{width:100,minWidth:100,maxWidth:100,padding:'10px 6px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:'2px solid '+(allAck?'#16a34a20':machColor+'20'),background:machColor+'08',gap:4}}>
<div style={{fontSize:15,fontWeight:800,color:C.text,textAlign:'center',lineHeight:'1.2'}}>{emp.name}</div>
<div style={{fontSize:13,fontWeight:700,color:machColor,textAlign:'center'}}>{grp.m?grp.m.name:'?'}</div>
{isMonthly&&<div style={{fontSize:10,color:C.dim,textAlign:'center'}}>{fmtMoney(dailySalary)}/j</div>}
<button onClick={e=>{e.stopPropagation();const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:eId,machineId:grp.m?grp.m.id:emp.machineId||'',clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}} style={{background:C.accent,color:'#fff',border:'none',borderRadius:4,width:22,height:22,cursor:'pointer',fontSize:14,fontWeight:700,lineHeight:'20px',padding:0}}>+</button>
</div>
{/* Côté droit: lignes de chantiers */}
<div style={{flex:1,minWidth:0}}>
{/* Ligne heures */}
<div style={{padding:'4px 10px',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',borderBottom:'1px solid '+C.border,fontSize:13}}>
<span style={{color:C.dim}}>theo {(()=>{const th0=grp.missions[0]?calcTheoreticalTimes(grp.missions[0].j,data,pMinGlobal):null;return th0?<React.Fragment><b>{th0.theoStart}</b>{'→'}<b>{th0.theoEnd}</b></React.Fragment>:'--'})()}</span>
<span style={{color:C.dim}}>reel {mainTE&&mainTE.startTime?<b style={{color:C.accent}}>{mainTE.startTime}</b>:<span style={{color:C.muted}}>--:--</span>}{'→'}{mainTE&&mainTE.endTime?<b style={{color:C.accent}}>{mainTE.endTime}</b>:<span style={{color:C.muted}}>--:--</span>}</span>
{startBadge&&<span style={{padding:'1px 6px',borderRadius:10,fontSize:11,fontWeight:700,background:startBadge.color+'18',color:startBadge.color}}>{startBadge.text}</span>}
{endBadge&&<span style={{padding:'1px 6px',borderRadius:10,fontSize:11,fontWeight:700,background:endBadge.color+'18',color:endBadge.color}}>{endBadge.text}</span>}
</div>
{grp.missions.map(({j,m,mt,fuelType,trajL,trajCost,machCost,salRoute,rev,cl,benefAffiche,marginPct})=>{
const theoJ=calcTheoreticalTimes(j,data,pMinGlobal);
const depName=j.startFrom==='home'?'Domicile':(getDepot(j.startFrom)||{}).name||'';
const arrName=j.endAt==='home'?'Domicile':(getDepot(j.endAt)||{}).name||'';
return(
<div key={j.id} style={{borderBottom:'1px solid '+C.border,background:j.ack?'#dcfce7':C.card}}>
<div style={{padding:'6px 10px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
<select value={j.clientId||''} onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau client:');if(n){const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:n,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.clientId=nc.id}save(nd)}}else{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.clientId=e.target.value;const m3=getMach(jj.machineId);if(m3&&jj.forfaitType){const p=getForfaitPrice(nd,e.target.value,m3,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:100,maxWidth:150}}>
<option value="">Client</option>{(data.clients||[]).map(c2=><option key={c2.id} value={c2.id}>{c2.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<select value={j.siteManager||''} onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau chef chantier:');if(n){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.siteManager=n;const cl2=(nd.clients||[]).find(c2=>c2.id===j.clientId);if(cl2){if(!cl2.siteManagers)cl2.siteManagers=[];if(!cl2.siteManagers.find(s=>s.name===n)){const ph=prompt('Tel du chef (optionnel):','')||'';cl2.siteManagers.push({name:n,phone:ph});jj.siteManagerPhone=ph}}save(nd)}}}else{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.siteManager=e.target.value;const cl2=(data.clients||[]).find(c2=>c2.id===j.clientId);const sm=(cl2&&cl2.siteManagers||[]).find(s=>s.name===e.target.value);if(sm)jj.siteManagerPhone=sm.phone||'';save(nd)}}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:80,maxWidth:130}}>
<option value="">Chef</option>{(cl&&cl.siteManagers||[]).map((s,si)=><option key={si} value={s.name}>{s.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<input value={j.location||''} placeholder="Lieu / adresse" onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.location=e.target.value;save(nd)}}} style={{fontSize:15,padding:'4px 8px',borderRadius:6,border:'1px solid '+C.border,minWidth:100,flex:1,maxWidth:220,background:'#fff'}}/>
<input type="time" value={j.billingStart||'08:00'} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.billingStart=e.target.value;save(nd)}}} style={{fontSize:15,padding:'4px 4px',borderRadius:6,border:'2px solid '+C.orange+'40',background:C.orange+'08',color:C.orange,fontWeight:700,width:75}}/>
<input value={j.gps||''} placeholder="GPS lat,lon" onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.gps=e.target.value;save(nd)}}} style={{fontSize:12,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,width:110,background:'#fff',color:C.dim}}/>
{(()=>{const gpsJ=parseCoords(j.gps);const empCo2=getEmpCoords(data,j.employeeId);const depOptions2=[{id:'home',name:'Dom.',co:empCo2},...(data.depots||[]).map(d2=>({id:d2.id,name:d2.name,co:d2._coords?parseCoords(typeof d2._coords==='string'?d2._coords:d2._coords.join(',')):null}))].map(o=>({...o,km:o.co&&gpsJ?+(haversine(o.co,gpsJ)*1.3).toFixed(0):null}));const arrOptions2=depOptions2.map(o=>({...o,km:o.co&&gpsJ?+(haversine(gpsJ,o.co)*1.3).toFixed(0):null}));const validDep=depOptions2.filter(o=>o.km!==null);const validArr=arrOptions2.filter(o=>o.km!==null);const shortDep=validDep.length>0?validDep.reduce((mn,o)=>o.km<mn.km?o:mn,validDep[0]):null;const shortArr=validArr.length>0?validArr.reduce((mn,o)=>o.km<mn.km?o:mn,validArr[0]):null;
if(gpsJ&&!j.startFrom&&shortDep){setTimeout(()=>{const nd2=JSON.parse(JSON.stringify(data));const jj2=nd2.jobs.find(x=>x.id===j.id);if(jj2&&!jj2.startFrom){jj2.startFrom=shortDep.id;jj2.kmAller=shortDep.km;if(!jj2.endAt&&shortArr){jj2.endAt=shortArr.id;jj2.kmRetour=shortArr.km}jj2.distanceKm=(jj2.kmAller||0)+(jj2.kmRetour||0);save(nd2)}},0)}
return(<React.Fragment>
<select value={j.startFrom||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.startFrom=e.target.value;const sel2=depOptions2.find(o=>o.id===e.target.value);jj.kmAller=sel2&&sel2.km?sel2.km:0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 3px',borderRadius:4,border:'1px solid #0891b240',background:j.startFrom&&shortDep&&j.startFrom===shortDep.id?'#0891b218':'#0891b208',color:'#0891b2',fontWeight:600,minWidth:60,maxWidth:110}}>
<option value="">↗Dep</option>{depOptions2.map(o=><option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km':''}{shortDep&&o.id===shortDep.id?' ★':''}</option>)}
</select>
<select value={j.endAt||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.endAt=e.target.value;const sel2=arrOptions2.find(o=>o.id===e.target.value);jj.kmRetour=sel2&&sel2.km?sel2.km:0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 3px',borderRadius:4,border:'1px solid #7c3aed40',background:j.endAt&&shortArr&&j.endAt===shortArr.id?'#7c3aed18':'#7c3aed08',color:'#7c3aed',fontWeight:600,minWidth:60,maxWidth:110}}>
<option value="">↙ Arr.</option>{arrOptions2.map(o=><option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km':''}{shortArr&&o.id===shortArr.id?' ★':''}</option>)}
</select>
</React.Fragment>)})()}
<select value={j.forfaitType||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj&&m){jj.forfaitType=e.target.value;const p=getForfaitPrice(nd,j.clientId,m,e.target.value,j.citOption,j.isNight);if(p)jj.priceForfait=p;save(nd)}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'2px solid '+(j.forfaitType?FC[j.forfaitType]||C.accent:C.border),background:j.forfaitType?(FC[j.forfaitType]||C.accent)+'15':'#fff',color:j.forfaitType?FC[j.forfaitType]||C.accent:C.dim,fontWeight:j.forfaitType?700:400,minWidth:40}}>
<option value="">F</option>{(mt==='Citerne'?['Demi-journee','Journee']:['2h','4h','6h','8h']).map(f=><option key={f} value={f}>{f}</option>)}
</select>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj&&m){jj.hasTransfer=!jj.hasTransfer;if(jj.hasTransfer&&!jj.transferPrice){const tp=getTransferPrice(nd,j.clientId,m,j.citOption,j.isNight);jj.transferPrice=tp||0}save(nd)}}} style={{padding:'4px 8px',borderRadius:6,fontSize:14,border:'2px solid '+(j.hasTransfer?C.purple:C.muted),background:j.hasTransfer?C.purple+'20':'transparent',color:j.hasTransfer?C.purple:C.dim,cursor:'pointer',fontWeight:j.hasTransfer?700:400}}>{j.hasTransfer?'T ✓':'+T'}</button>
<div style={{marginLeft:'auto',display:'flex',gap:4,alignItems:'center'}}>
<button onClick={()=>toggleDetail(j.id)} style={{background:'none',border:'2px solid '+C.border,borderRadius:6,fontSize:14,cursor:'pointer',padding:'4px 8px',color:C.dim,fontWeight:600}}>{openDetails[j.id]?'▲':'▼'}</button>
<button onClick={e=>{e.stopPropagation();if(confirm('Supprimer ?')){const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(x=>x.id!==j.id);save(nd)}}} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:C.red,fontWeight:700}}>×</button>
</div>
</div>
{/* Details panel */}
{openDetails[j.id]&&<div style={{padding:'8px 12px',borderTop:'1px solid '+C.border,background:'#fafbfc'}}>
<div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:6,fontSize:14}}>
<span style={{color:C.red,fontWeight:600}}>Couts -{fmtMoney(totalCostsDay)}</span>
{dTotalEntretienMach>0&&machRembourse&&dTotalEntretienCam>0&&camRembourse&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:700,background:C.green+'18',color:C.green}}>Entretien ✓</span>}
{!(dTotalEntretienMach>0&&machRembourse&&dTotalEntretienCam>0&&camRembourse)&&<React.Fragment>
{dTotalEntretienMach>0&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:700,background:(machRembourse?C.green:C.red)+'18',color:machRembourse?C.green:C.red}}>{machRembourse?'Mach. ✓':'Mach. reste '+fmtMoney(resteMach)}</span>}
{dTotalEntretienCam>0&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:700,background:(camRembourse?C.green:C.red)+'18',color:camRembourse?C.green:C.red}}>{camRembourse?'Cam. ✓':'Cam. reste '+fmtMoney(resteCam)}</span>}
</React.Fragment>}
<span style={{fontWeight:700,fontSize:15,color:dBenefAffiche>0?C.green:C.red}}>Benef {dBenefAffiche>0?'+':''}{fmtMoney(dBenefAffiche)}</span>
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:4,fontSize:10}}>
<div style={{background:'#7c3aed08',borderRadius:6,padding:6,border:'1px solid #7c3aed15'}}>
<div style={{fontWeight:800,color:'#7c3aed',marginBottom:4,fontSize:11}}>SALAIRE</div>
<div style={{display:'flex',justifyContent:'space-between'}}><span>Chantier</span><span>{fmtMoney(salChantier)}</span></div>
<div style={{display:'flex',justifyContent:'space-between'}}><span>Route</span><span>{fmtMoney(totalSalRouteDay)}</span></div>
{surcoutEmb>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span>Emb.</span><span>{fmtMoney(surcoutEmb)}</span></div>}
{surcoutDeb>0&&<div style={{display:'flex',justifyContent:'space-between'}}><span>Deb.</span><span>{fmtMoney(surcoutDeb)}</span></div>}
<div style={{borderTop:'1px solid #7c3aed20',marginTop:3,paddingTop:3,fontWeight:700,display:'flex',justifyContent:'space-between'}}><span>Total</span><span>{fmtMoney(dTotalSalaire)}</span></div>
</div>
<div style={{background:'#d9770608',borderRadius:6,padding:6,border:'1px solid #d9770615'}}>
<div style={{fontWeight:800,color:'#d97706',marginBottom:4,fontSize:11}}>CARBURANT</div>
{jobCalcs.map((c2,ci)=>c2.trajL>0?<div key={ci} style={{display:'flex',justifyContent:'space-between'}}><span>Trajet {c2.trajL.toFixed(0)}L</span><span>{fmtMoney(c2.trajCost)}</span></div>:null)}
{jobCalcs.map((c2,ci)=>c2.machCost>0?<div key={'m'+ci} style={{display:'flex',justifyContent:'space-between'}}><span>Machine {(c2.j.machineFuelL||0)}L</span><span>{fmtMoney(c2.machCost)}</span></div>:null)}
<div style={{borderTop:'1px solid #d9770620',marginTop:3,paddingTop:3,fontWeight:700,display:'flex',justifyContent:'space-between'}}><span>Total</span><span>{fmtMoney(dTotalCarbu)}</span></div>
</div>
<div style={{background:'#64748b08',borderRadius:6,padding:6,border:'1px solid #64748b15'}}>
<div style={{fontWeight:800,color:'#64748b',marginBottom:4,fontSize:11}}>FIXES / JOUR</div>
{jobCalcs.map((c2,ci)=>{const items=[];if(c2.credM>0)items.push(['Cr.mach',c2.credM]);if(c2.assM>0)items.push(['Ass.mach',c2.assM]);if(c2.ctM>0)items.push(['CT mach',c2.ctM]);if(c2.credT>0)items.push(['Cr.cam',c2.credT]);if(c2.assT>0)items.push(['Ass.cam',c2.assT]);if(c2.ctT>0)items.push(['CT cam',c2.ctT]);return items.map(([l,v],ii)=><div key={ci+'_'+ii} style={{display:'flex',justifyContent:'space-between'}}><span>{l}</span><span>{fmtMoney(v)}</span></div>)})}
<div style={{borderTop:'1px solid #64748b20',marginTop:3,paddingTop:3,fontWeight:700,display:'flex',justifyContent:'space-between'}}><span>Total</span><span>{fmtMoney(dTotalFixes)}</span></div>
</div>
<div style={{borderRadius:6,padding:6,border:'1px solid #64748b15',background:'#f8fafc'}}>
<div style={{fontWeight:800,color:'#64748b',marginBottom:4,fontSize:11}}>ENTRETIEN</div>
{dTotalEntretienMach>0&&<div style={{background:machRembourse?'#16a34a08':'#dc262608',borderRadius:4,padding:4,marginBottom:3,border:'1px solid '+(machRembourse?'#16a34a15':'#dc262615')}}>
<div style={{fontWeight:700,fontSize:9,color:machRembourse?C.green:C.red}}>MACHINE</div>
<div style={{display:'flex',justifyContent:'space-between'}}><span>{fmtMoney(dTotalEntretienMach)}</span><span style={{color:C.green}}>{fmtMoney(Math.max(0,dTotalEntretienMach-resteMach))}</span></div>
<div style={{height:4,background:'#e2e8f0',borderRadius:2,overflow:'hidden',marginTop:2}}><div style={{height:'100%',width:pctMach.toFixed(0)+'%',background:machRembourse?C.green:C.red,borderRadius:2}}/></div>
</div>}
{dTotalEntretienCam>0&&<div style={{background:camRembourse?'#16a34a08':'#dc262608',borderRadius:4,padding:4,border:'1px solid '+(camRembourse?'#16a34a15':'#dc262615')}}>
<div style={{fontWeight:700,fontSize:9,color:camRembourse?C.green:C.red}}>CAMION</div>
<div style={{display:'flex',justifyContent:'space-between'}}><span>{fmtMoney(dTotalEntretienCam)}</span><span style={{color:C.green}}>{fmtMoney(Math.max(0,dTotalEntretienCam-resteCam))}</span></div>
<div style={{height:4,background:'#e2e8f0',borderRadius:2,overflow:'hidden',marginTop:2}}><div style={{height:'100%',width:pctCam.toFixed(0)+'%',background:camRembourse?C.green:C.red,borderRadius:2}}/></div>
</div>}
{dTotalEntretienMach===0&&dTotalEntretienCam===0&&<div style={{color:C.muted,fontSize:9,fontStyle:'italic'}}>Aucune</div>}
</div>
</div>
</div>}
</div>)})}
</div>
</div>)})})()}
</React.Fragment>)})})()}
</div>)};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
<div style={{display:'flex',alignItems:'center',gap:6}}>
<button onClick={()=>navDate(-1)} style={btnStyle(C.dim)}>{'<'}</button>
<span style={{fontWeight:700,fontSize:18,color:'#fff'}}>{fmtDate(new Date(selDate))}</span>
<button onClick={()=>navDate(1)} style={btnStyle(C.dim)}>{'>'}</button>
<input type="date" value={selDate} onChange={e=>setSelDate(e.target.value)} style={{...inputStyle,width:140,marginLeft:4}}/>
</div>
<button onClick={()=>{setFormJob(null);setFormEmpId('');setShowForm(true)}} style={btnStyle(C.accent,true)}>+ Chantier</button>
</div>
<div style={{display:'flex',gap:12,marginBottom:12,flexWrap:'wrap'}}>
<div style={{background:C.card,borderRadius:8,padding:'8px 14px',border:'1px solid '+C.border}}><span style={{fontSize:12,color:C.dim}}>CA jour </span><span style={{fontWeight:700,color:C.accent}}>{fmtMoney(caTotal)}</span></div>
<div style={{background:C.card,borderRadius:8,padding:'8px 14px',border:'1px solid '+C.border}}><span style={{fontSize:12,color:C.dim}}>Dispo </span>{availDrivers.map(e=><Bg key={e.id} text={e.name.split(' ')[0]} color={C.orange} style={{marginLeft:4}}/>)}</div>
{(()=>{const newPannes=(data.panneReports||[]).filter(p=>p.status!=='resolved');return newPannes.length>0?<div style={{background:'#fef2f2',borderRadius:8,padding:'8px 14px',border:'1px solid #fecaca',display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}><span style={{fontSize:14,fontWeight:700,color:C.red}}>&#9888; {newPannes.length} panne{newPannes.length>1?'s':''}</span>{newPannes.map(p=>{const allEq=[...(data.machines||[]).map(m=>({id:m.id,name:m.name})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name})),...(data.cars||[]).map(c=>({id:c.id,name:c.name}))];const eq=allEq.find(x=>x.id===(p.machineId||p.truckId||p.carId));const reporter=(data.employees||[]).find(e=>e.id===p.reportedBy);return(<span key={p.id} style={{padding:'3px 10px',borderRadius:8,fontSize:13,fontWeight:600,background:p.severity==='urgent'?'#dc262618':'#d9770618',color:p.severity==='urgent'?C.red:C.orange,border:'1px solid '+(p.severity==='urgent'?'#dc262630':'#d9770630')}}>{eq?eq.name:'?'} — {(p.description||'').slice(0,30)}{p.description&&p.description.length>30?'...':''} {reporter?'('+reporter.name.split(' ')[0]+')':''} {p.severity==='urgent'?'URGENT':''}</span>)})}</div>:null})()}
</div>
<div className="pg" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
{renderCol(['Raboteuse'],'Raboteuses')}
{renderCol(['Balayeuse','Citerne'],'Balayeuses + Citernes')}
</div>
{showForm&&<MissionForm data={data} save={save} job={formJob} onClose={()=>setShowForm(false)} selectedDate={selDate} selectedEmpId={formEmpId}/>}
{showDepotForm&&<Mod title="Journee depot" onClose={()=>setShowDepotForm(false)} width={400}>
<Fl label="Depot"><select style={inputStyle} value={depotFormDepotId} onChange={e=>setDepotFormDepotId(e.target.value)}><option value="">-- Choisir --</option>{(data.depots||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Fl>
<Fl label="Activite"><select style={inputStyle} value={depotFormActivity} onChange={e=>setDepotFormActivity(e.target.value)}>{DEPOT_ACTIVITIES.map(a=><option key={a} value={a}>{a}</option>)}</select></Fl>
{depotFormActivity==='Autre'&&<Fl label="Description"><input style={inputStyle} value={depotFormDesc} onChange={e=>setDepotFormDesc(e.target.value)} placeholder="Description libre"/></Fl>}
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={saveDepotJob} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>setShowDepotForm(false)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
</div>)};

// ======== DASHBOARD ========
const DashboardPage=({data})=>{
const[period,setPeriod]=useState('Semaine');const[offset,setOffset]=useState(0);
const wdpm=data.workDaysPerMonth||22;
const yearStart=data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1));
const range=useMemo(()=>{const now=new Date();if(period==='Jour'){const d=new Date(now);d.setDate(d.getDate()+offset);const s=fmtDateISO(d);return{start:s,end:s,label:fmtDate(d)}}if(period==='Semaine'){const d=new Date(now);d.setDate(d.getDate()+offset*7);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const mon=new Date(d);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);return{start:fmtDateISO(mon),end:fmtDateISO(sun),label:fmtDate(mon)+' - '+fmtDate(sun)}}if(period==='Annee'){const yr=now.getFullYear()+offset;return{start:yr+'-01-01',end:yr+'-12-31',label:''+yr}}const d=new Date(now.getFullYear(),now.getMonth()+offset,1);const last=new Date(d.getFullYear(),d.getMonth()+1,0);return{start:fmtDateISO(d),end:fmtDateISO(last),label:d.toLocaleString('fr-FR',{month:'long',year:'numeric'})}},[period,offset]);
const prevRange=useMemo(()=>{const now=new Date();const o2=offset-1;if(period==='Jour'){const d=new Date(now);d.setDate(d.getDate()+o2);const s=fmtDateISO(d);return{start:s,end:s}}if(period==='Semaine'){const d=new Date(now);d.setDate(d.getDate()+o2*7);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const mon=new Date(d);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);return{start:fmtDateISO(mon),end:fmtDateISO(sun)}}if(period==='Annee'){const yr=now.getFullYear()+o2;return{start:yr+'-01-01',end:yr+'-12-31'}}const d=new Date(now.getFullYear(),now.getMonth()+o2,1);const last=new Date(d.getFullYear(),d.getMonth()+1,0);return{start:fmtDateISO(d),end:fmtDateISO(last)}},[period,offset]);
const jobs=useMemo(()=>(data.jobs||[]).filter(j=>j.date>=range.start&&j.date<=range.end&&j.type!=='depot'),[data.jobs,range]);
const prevJobs=useMemo(()=>(data.jobs||[]).filter(j=>j.date>=prevRange.start&&j.date<=prevRange.end&&j.type!=='depot'),[data.jobs,prevRange]);
const caTotal=jobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const prevCA=prevJobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const calcCosts=(jobList)=>{let total=0;jobList.forEach(j=>{const emp=(data.employees||[]).find(e=>e.id===j.employeeId);const m=(data.machines||[]).find(x=>x.id===j.machineId);const hourly=emp?Number(emp.hourlySalary)||0:0;const chargesRate=emp?Number(emp.chargesRate)||45:45;const mealA=emp?Number(emp.mealAllowance)||12:12;const fh=forfaitHours(j.forfaitType);const salBrut=fh*hourly;const salCharges=salBrut*(1+chargesRate/100);const fuelType=getMachineFuelType(data,j.machineId);const truck2=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);const truckC=truck2?Number(truck2.fuelPer100)||25:25;const trajKm=(j.distanceKm||0);const trajL=(trajKm/100)*truckC;const fuelPr=getFuelPrice(data,fuelType,j.startFrom!=='home'?j.startFrom:null);const trajCost=trajL*fuelPr;const machFuelPr=getFuelPrice(data,fuelType,j.machineFuelDepot);const machCost=(j.machineFuelL||0)*machFuelPr;const assM=m?((m.insuranceMonthly||0)/wdpm):0;const credM=m?(Number(m.creditMonthly)||0)/wdpm:0;const ctM=m?((m.ctCost||0)/12)/wdpm:0;const assT=truck2?((truck2.insuranceMonthly||0)/wdpm):0;const credT=truck2?(Number(truck2.creditMonthly)||0)/wdpm:0;const ctT=truck2?((truck2.ctCost||0)/12)/wdpm:0;total+=salCharges+mealA+trajCost+machCost+assM+credM+ctM+assT+credT+ctT});return total};
const costsTotal=calcCosts(jobs);const prevCosts=calcCosts(prevJobs);
const totalEntretienPeriod=(data.interventions||[]).filter(i=>i.date>=range.start&&i.date<=range.end).reduce((s,i)=>s+(i.totalCost||0),0);
const totalEntretienYTD=(data.interventions||[]).filter(i=>i.date>=yearStart).reduce((s,i)=>s+(i.totalCost||0),0);
const benefBrutTotal=caTotal-costsTotal;
const benefCumYTD=useMemo(()=>{const allJ=(data.jobs||[]).filter(j=>j.date>=yearStart&&j.date<=range.end&&j.type!=='depot');return allJ.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0)-calcCosts(allJ)},[data,yearStart,range]);
const resteEntretien=totalEntretienYTD-benefCumYTD;
const benefAffiche=resteEntretien>0?0:benefBrutTotal;
const prevBenef=prevCA-prevCosts;
const margePct=caTotal>0?((benefAffiche/caTotal)*100):0;
const caByType={};jobs.forEach(j=>{const m=(data.machines||[]).find(x=>x.id===j.machineId);const t=m?m.type:'Autre';caByType[t]=(caByType[t]||0)+(j.priceForfait||0)});
const maxCABar=Math.max(...Object.values(caByType),1);
const clientCA={};jobs.forEach(j=>{const cn=(data.clients||[]).find(c=>c.id===j.clientId);const n=cn?cn.name:'?';if(!clientCA[n])clientCA[n]={ca:0,cnt:0};clientCA[n].ca+=(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0);clientCA[n].cnt++});
const topCl=Object.entries(clientCA).sort((a,b)=>b[1].ca-a[1].ca);
const alerts=useMemo(()=>{const a=[];const d30=fmtDateISO(new Date(Date.now()+30*86400000));(data.panneReports||[]).filter(p=>p.status==='new'&&p.severity==='urgent').forEach(p=>{const eq=[...(data.machines||[]),...(data.trucks||[]),...(data.cars||[])].find(x=>x.id===(p.machineId||p.truckId||p.carId));a.push({t:'Panne urgente: '+(eq?eq.name:'?')+' - '+(p.description||'').substring(0,40),c:C.red,type:'panne'})});(data.parts||[]).filter(p=>(p.quantity||0)<=(p.minStock||2)).forEach(p=>{a.push({t:'Stock bas: '+p.name+' ('+p.quantity+')',c:C.orange,type:'stock'})});(data.trucks||[]).concat(data.cars||[]).forEach(v=>{if(v.ctDate&&v.ctDate<=d30)a.push({t:'CT '+v.name+' : '+v.ctDate,c:C.orange,type:'ct'});if(v.vidangeDate&&v.vidangeDate<=d30)a.push({t:'Vidange '+v.name+' : '+v.vidangeDate,c:C.orange,type:'vidange'})});(data.panneReports||[]).filter(p=>p.status!=='resolved'&&p.severity!=='urgent').forEach(p=>{a.push({t:'Panne: '+(p.description||'').substring(0,40),c:C.orange,type:'panne'})});return a},[data]);
const machStats=useMemo(()=>(data.machines||[]).map(mach=>{const mJobs=jobs.filter(j=>j.machineId===mach.id);const ca=mJobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);const fuelCost=mJobs.reduce((s,j)=>{const ft=getMachineFuelType(data,mach.id);const fp=getFuelPrice(data,ft,j.machineFuelDepot);return s+(j.machineFuelL||0)*fp},0);const assJour=(mach.insuranceMonthly||0)/wdpm;const credJour=(Number(mach.creditMonthly)||0)/wdpm;const ctJour=((mach.ctCost||0)/12)/wdpm;const daysUsed=[...new Set(mJobs.map(j=>j.date))].length;const fixedCost=(assJour+credJour+ctJour)*daysUsed;const interCost=(data.interventions||[]).filter(i=>i.machineId===mach.id&&i.date>=range.start&&i.date<=range.end).reduce((s,i)=>s+(i.totalCost||0),0);const cost=fuelCost+fixedCost+interCost;const benef=ca-cost;const margePct2=ca>0?((benef/ca)*100):0;const months2=[];const d=new Date(yearStart);for(let i2=0;i2<12;i2++){const mo=new Date(d.getFullYear(),d.getMonth()+i2,1);const last=new Date(mo.getFullYear(),mo.getMonth()+1,0);if(mo>new Date())break;const ms=fmtDateISO(mo);const me=fmtDateISO(last);const moJobs=(data.jobs||[]).filter(j2=>j2.machineId===mach.id&&j2.date>=ms&&j2.date<=me&&j2.type!=='depot');const moCa=moJobs.reduce((s2,j2)=>s2+(j2.priceForfait||0)+(j2.hasTransfer?j2.transferPrice||0:0),0);const moInter=(data.interventions||[]).filter(ii=>ii.machineId===mach.id&&ii.date>=ms&&ii.date<=me).reduce((s2,ii)=>s2+(ii.totalCost||0),0);const moFuel=moJobs.reduce((s2,j2)=>{const ft2=getMachineFuelType(data,mach.id);const fp2=getFuelPrice(data,ft2,j2.machineFuelDepot);return s2+(j2.machineFuelL||0)*fp2},0);months2.push({label:mo.toLocaleString('fr-FR',{month:'short'}),ca:moCa,cost:moFuel+moInter+(assJour+credJour+ctJour)*([...new Set(moJobs.map(j2=>j2.date))].length)})}let cumBenef=0;let pmLabel=null;months2.forEach(mo2=>{cumBenef+=mo2.ca-mo2.cost;if(cumBenef>0&&!pmLabel)pmLabel=mo2.label});return{name:mach.name,type:mach.type,ca,cost,benef,margePct:margePct2,pmLabel}}),[data,jobs,range,yearStart,wdpm]);
const driverStats=useMemo(()=>{const empIds=[...new Set(jobs.map(j=>j.employeeId))];return empIds.map(eId=>{const emp=(data.employees||[]).find(e=>e.id===eId);if(!emp)return null;const eJobs=jobs.filter(j=>j.employeeId===eId);const ca=eJobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);const hourly=Number(emp.hourlySalary)||0;const chargesRate=Number(emp.chargesRate)||45;const salBrut=hourly;const workDays=[...new Set(eJobs.map(j=>j.date))].length;const te=(data.timeEntries||[]).filter(t=>t.empId===eId&&t.date>=range.start&&t.date<=range.end);let totalWorkMin=0;te.forEach(t=>{if(t.startTime&&t.endTime){const[sh,sm]=t.startTime.split(':').map(Number);const[eh,em]=t.endTime.split(':').map(Number);totalWorkMin+=(eh*60+em)-(sh*60+sm)-(t.pauseMin||0)}});const salTotal=(totalWorkMin/60)*hourly;const salCharges=salTotal*(1+chargesRate/100);const ratio=salCharges>0?(ca/salCharges):0;return{name:emp.name,ca,salCharges,missions:eJobs.length,days:workDays,ratio,initial:(emp.name||'?')[0].toUpperCase()}}).filter(Boolean).sort((a,b)=>b.ca-a.ca)},[data,jobs,range]);
const totalStockVal=(data.parts||[]).reduce((s,p)=>s+(p.quantity||0)*(p.unitPrice||0),0);
const lowStockParts=(data.parts||[]).filter(p=>(p.quantity||0)<=(p.minStock||2));
const unresolvedPannes=(data.panneReports||[]).filter(p=>p.status!=='resolved');
const inProgressPannes=(data.panneReports||[]).filter(p=>p.status==='in_progress');
const monthInterventions=(data.interventions||[]).filter(i=>i.date>=range.start&&i.date<=range.end);
const monthInterCost=monthInterventions.reduce((s,i)=>s+(i.totalCost||0),0);
const pctDiff=(cur,prev)=>{if(!prev)return null;const d=((cur-prev)/Math.abs(prev))*100;return d};
const kpi=(l,v,c,prev)=>{const diff=pctDiff(typeof v==='number'?v:0,prev);return(<div style={{background:C.card,borderRadius:10,padding:16,border:'1px solid '+C.border}}><div style={{fontSize:12,color:C.dim,marginBottom:4}}>{l}</div><div style={{fontSize:22,fontWeight:800,color:c||C.text}}>{typeof v==='number'?fmtMoney(v):v}</div>{diff!==null&&<div style={{fontSize:11,marginTop:4,color:diff>=0?C.green:C.red,fontWeight:600}}>{diff>=0?'▲':'▼'} {Math.abs(diff).toFixed(0)}% vs prec.</div>}</div>)};
const calendarDays=useMemo(()=>{if(period!=='Mois')return[];const d=new Date(range.start);const yr=d.getFullYear();const mo=d.getMonth();const first=new Date(yr,mo,1);const last=new Date(yr,mo+1,0);const startDay=(first.getDay()+6)%7;const days=[];for(let i=0;i<startDay;i++)days.push(null);for(let i=1;i<=last.getDate();i++){const ds=yr+'-'+pad2(mo+1)+'-'+pad2(i);const dj=(data.jobs||[]).filter(j=>j.date===ds&&j.type!=='depot');const dca=dj.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);days.push({day:i,date:ds,missions:dj.length,ca:dca})}return days},[period,range,data.jobs]);
const maxDayCA=Math.max(...calendarDays.filter(Boolean).map(d=>d.ca),1);
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:8}}>
<h2 style={{margin:0,fontSize:20}}>Dashboard</h2>
<div style={{display:'flex',alignItems:'center',gap:6}}>
{['Jour','Semaine','Mois','Annee'].map(p=><button key={p} onClick={()=>{setPeriod(p);setOffset(0)}} style={{...btnStyle(C.accent,period===p),fontSize:13}}>{p}</button>)}
<button onClick={()=>setOffset(o=>o-1)} style={btnStyle(C.dim)}>{'<'}</button><span style={{fontWeight:600,fontSize:14}}>{range.label}</span><button onClick={()=>setOffset(o=>o+1)} style={btnStyle(C.dim)}>{'>'}</button>
</div></div>
<div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
{kpi('CA',caTotal,C.accent,prevCA)}
{kpi('Couts',costsTotal+totalEntretienPeriod,C.red,prevCosts)}
{kpi('Benefice',benefAffiche,benefAffiche>=0?C.green:C.red,prevBenef)}
<div style={{background:C.card,borderRadius:10,padding:16,border:'1px solid '+C.border}}><div style={{fontSize:12,color:C.dim,marginBottom:4}}>Missions</div><div style={{fontSize:22,fontWeight:800}}>{jobs.length}</div><div style={{fontSize:11,marginTop:4,color:C.dim}}>Marge: <b style={{color:margePct>=0?C.green:C.red}}>{margePct.toFixed(0)}%</b></div></div>
</div>
{alerts.length>0&&<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:8,color:C.red}}>Alertes ({alerts.length})</div>
{alerts.map((a,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:8,fontSize:13,padding:'6px 8px',marginBottom:4,borderRadius:6,borderLeft:'3px solid '+a.c,background:a.c+'08'}}><Bg text={a.type} color={a.c}/><span>{a.t}</span></div>)}
</div>}
<div className="pg" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>CA par type</div>
<div style={{display:'flex',alignItems:'flex-end',gap:16,height:120}}>
{[['Raboteuse','#008965'],['Balayeuse',C.green],['Citerne',C.cyan]].map(([t,color])=>(
<div key={t} style={{flex:1,textAlign:'center'}}><div style={{height:Math.max(((caByType[t]||0)/maxCABar)*100,4),background:color,borderRadius:4,marginBottom:4}}/><div style={{fontSize:11,fontWeight:600}}>{t}</div><div style={{fontSize:11,color:C.dim}}>{fmtMoney(caByType[t]||0)}</div></div>
))}
</div></div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Top clients</div>
{topCl.slice(0,8).map(([n,d],i)=><div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,padding:'4px 0',borderBottom:'1px solid #f1f5f9'}}><span style={{fontWeight:i<3?700:400}}>{i+1}. {n}</span><span><b>{fmtMoney(d.ca)}</b> <span style={{color:C.dim}}>({d.cnt})</span></span></div>)}
</div></div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Rentabilite par machine</div>
<div style={{overflowX:'auto'}}>
<table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
<thead><tr style={{borderBottom:'2px solid '+C.border}}>{['Machine','CA','Couts','Benef','Marge%','Point mort'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 8px',color:C.dim,fontWeight:600,fontSize:12}}>{h}</th>)}</tr></thead>
<tbody>{machStats.map((ms,i)=><tr key={i} style={{borderBottom:'1px solid '+C.border}}>
<td style={{padding:'6px 8px',fontWeight:700,color:MC[ms.type]||C.accent}}>{ms.name}</td>
<td style={{padding:'6px 8px',color:C.accent,fontWeight:600}}>{fmtMoney(ms.ca)}</td>
<td style={{padding:'6px 8px',color:C.red}}>{fmtMoney(ms.cost)}</td>
<td style={{padding:'6px 8px',fontWeight:700,color:ms.benef>=0?C.green:C.red}}>{ms.benef>=0?'+':''}{fmtMoney(ms.benef)}</td>
<td style={{padding:'6px 8px'}}><span style={{fontWeight:700,color:ms.margePct>=30?C.green:ms.margePct>=0?C.orange:C.red}}>{ms.margePct.toFixed(0)}%</span></td>
<td style={{padding:'6px 8px'}}>{ms.pmLabel?<Bg text={ms.pmLabel} color={C.green}/>:<Bg text="pas atteint" color={C.orange}/>}</td>
</tr>)}</tbody>
</table></div></div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Rentabilite par chauffeur</div>
<div style={{overflowX:'auto'}}>
<table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
<thead><tr style={{borderBottom:'2px solid '+C.border}}>{['Chauffeur','CA genere','Sal+charges','Missions','Jours','Ratio'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 8px',color:C.dim,fontWeight:600,fontSize:12}}>{h}</th>)}</tr></thead>
<tbody>{driverStats.map((ds,i)=><tr key={i} style={{borderBottom:'1px solid '+C.border}}>
<td style={{padding:'6px 8px'}}><div style={{display:'flex',alignItems:'center',gap:6}}><div style={{width:24,height:24,borderRadius:'50%',background:C.accent,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700}}>{ds.initial}</div><span style={{fontWeight:600}}>{ds.name}</span></div></td>
<td style={{padding:'6px 8px',color:C.accent,fontWeight:600}}>{fmtMoney(ds.ca)}</td>
<td style={{padding:'6px 8px',color:C.red}}>{fmtMoney(ds.salCharges)}</td>
<td style={{padding:'6px 8px'}}>{ds.missions}</td>
<td style={{padding:'6px 8px'}}>{ds.days}</td>
<td style={{padding:'6px 8px'}}><span style={{fontWeight:700,color:ds.ratio>=7?C.green:ds.ratio>=5?C.orange:C.red}}>{ds.ratio.toFixed(1)}x</span></td>
</tr>)}</tbody>
</table></div></div>
<div className="pg" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Stock pieces</div>
<div style={{fontSize:13,marginBottom:6}}>Total: <b>{(data.parts||[]).reduce((s,p)=>s+(p.quantity||0),0)}</b> pieces | Valeur: <b style={{color:C.accent}}>{fmtMoney(totalStockVal)}</b></div>
{lowStockParts.length>0&&<div style={{marginTop:6}}>{lowStockParts.map((p,i)=><div key={i} style={{fontSize:12,color:C.orange,padding:'2px 0'}}>&#9888; {p.name}: {p.quantity} restant(s)</div>)}</div>}
{lowStockParts.length===0&&<div style={{fontSize:12,color:C.green}}>Tous les stocks OK</div>}
</div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Pannes & Interventions</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:13}}>
<div>Non resolues: <b style={{color:unresolvedPannes.length>0?C.red:C.green}}>{unresolvedPannes.length}</b></div>
<div>En cours: <b style={{color:C.orange}}>{inProgressPannes.length}</b></div>
<div>Interventions: <b>{monthInterventions.length}</b></div>
<div>Cout: <b style={{color:C.red}}>{fmtMoney(monthInterCost)}</b></div>
</div></div></div>
{period==='Mois'&&calendarDays.length>0&&<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Calendrier</div>
<div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}}>
{['L','M','M','J','V','S','D'].map((d,i)=><div key={i} style={{textAlign:'center',fontSize:11,fontWeight:700,color:C.dim,padding:4}}>{d}</div>)}
{calendarDays.map((d,i)=>d?<div key={i} style={{textAlign:'center',padding:6,borderRadius:6,background:d.ca>0?'rgba(0,137,101,'+(0.1+0.6*(d.ca/maxDayCA)).toFixed(2)+')':'#f8fafc',border:'1px solid '+C.border,cursor:'default'}}>
<div style={{fontSize:12,fontWeight:d.missions>0?700:400,color:d.missions>0?C.text:C.muted}}>{d.day}</div>
{d.missions>0&&<div style={{fontSize:9,fontWeight:700,color:C.accent}}>{d.missions}m</div>}
</div>:<div key={i}/>)}
</div></div>}
</div>)};

// ======== DEPOTS ========
const DepotsPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const[outType,setOutType]=useState(null);const[outDepot,setOutDepot]=useState(null);
const[outL,setOutL]=useState('');const[outEmp,setOutEmp]=useState('');const[outMach,setOutMach]=useState('');const[outTruck,setOutTruck]=useState('');const[outDate,setOutDate]=useState(fmtDateISO(new Date()));
const blank={name:'',address:'',_coords:null,gnrStock:0,gnrPrice:0,gazoleStock:0,gazolePrice:0,gnrHistory:[],gazoleHistory:[]};
const open=d=>{setSel(d?{...d}:{...blank,id:uid()});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const ds=data.depots||[];const idx=ds.findIndex(d=>d.id===sel.id);const nd=idx>=0?ds.map(d=>d.id===sel.id?sel:d):[...ds,sel];save({...data,depots:nd});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,depots:(data.depots||[]).filter(d=>d.id!==sel.id)});close()};
const doOut=()=>{if(!outDepot||!outL)return;const nd=JSON.parse(JSON.stringify(data));const dep=nd.depots.find(d=>d.id===outDepot);if(!dep)return;const liters=Number(outL)||0;const fld=outType==='gnr'?'gnr':'gazole';dep[fld+'Stock']=Math.max(0,(dep[fld+'Stock']||0)-liters);const hist=dep[fld+'History']||[];hist.unshift({type:'out',liters,date:outDate,employeeName:(nd.employees||[]).find(e=>e.id===outEmp)?.name||'',machineName:(nd.machines||[]).find(m=>m.id===outMach)?.name||'',truckName:(nd.trucks||[]).find(t=>t.id===outTruck)?.name||''});dep[fld+'History']=hist.slice(0,30);save(nd);setOutType(null);setOutDepot(null);setOutL('');setOutEmp('');setOutMach('');setOutTruck('')};
const gauge=(stock,price,color,label)=>{const maxL=5000;const pct=Math.min((stock/maxL)*100,100);return(
<div style={{flex:1}}><div style={{fontSize:12,fontWeight:700,color,marginBottom:4}}>{label}</div>
<div style={{height:16,background:'#e2e8f0',borderRadius:8,overflow:'hidden'}}><div style={{height:'100%',background:color,width:pct+'%',borderRadius:8,transition:'width .3s'}}/></div>
<div style={{fontSize:11,color:C.dim,marginTop:2}}>{stock||0} L | {fmtMoney(price)}/L | Total: {fmtMoney((stock||0)*(price||0))}</div>
{stock<200&&<div style={{fontSize:11,color:C.red,fontWeight:600}}>Stock bas!</div>}
</div>)};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Depots</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
{(data.depots||[]).map(dep=>(
<div key={dep.id} style={{background:C.card,borderRadius:12,padding:16,marginBottom:12,border:'1px solid '+C.border}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
<div><strong style={{fontSize:16}}>{dep.name}</strong><div style={{fontSize:12,color:C.dim}}>{dep.address||'Pas d\'adresse'} {dep._coords?'(GPS ok)':''}</div></div>
<EBtn onClick={()=>open(dep)}/></div>
<div style={{display:'flex',gap:16,marginBottom:10}}>{gauge(dep.gnrStock,dep.gnrPrice,C.orange,'GNR')}{gauge(dep.gazoleStock,dep.gazolePrice,C.accent,'Gazole')}</div>
<div style={{display:'flex',gap:6,marginBottom:8}}>
<button onClick={()=>{setOutType('gnr');setOutDepot(dep.id)}} style={{...btnStyle(C.orange),padding:'4px 10px',fontSize:12}}>Sortie GNR</button>
<button onClick={()=>{setOutType('gazole');setOutDepot(dep.id)}} style={{...btnStyle(C.accent),padding:'4px 10px',fontSize:12}}>Sortie Gazole</button>
</div>
{outType&&outDepot===dep.id&&<div style={{background:C.bg,borderRadius:8,padding:10,marginBottom:8,border:'1px solid '+C.border}}>
<div style={{fontWeight:600,fontSize:13,marginBottom:6}}>Sortie {outType==='gnr'?'GNR':'Gazole'}</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Chauffeur"><select style={inputStyle} value={outEmp} onChange={e=>setOutEmp(e.target.value)}><option value="">--</option>{(data.employees||[]).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Fl>
<Fl label="Machine"><select style={inputStyle} value={outMach} onChange={e=>setOutMach(e.target.value)}><option value="">--</option>{(data.machines||[]).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Fl>
{outType==='gazole'&&<Fl label="Camion"><select style={inputStyle} value={outTruck} onChange={e=>setOutTruck(e.target.value)}><option value="">--</option>{(data.trucks||[]).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Fl>}
<Fl label="Litres"><input type="number" style={inputStyle} value={outL} onChange={e=>setOutL(e.target.value)}/></Fl>
<Fl label="Date"><input type="date" style={inputStyle} value={outDate} onChange={e=>setOutDate(e.target.value)}/></Fl>
</div>
<div style={{display:'flex',gap:6}}><button onClick={doOut} style={btnStyle(C.accent,true)}>Valider</button><button onClick={()=>{setOutType(null);setOutDepot(null)}} style={btnStyle(C.dim)}>Annuler</button></div>
</div>}
<div style={{fontSize:12}}>
{[...(dep.gnrHistory||[]),...(dep.gazoleHistory||[])].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10).map((h,i)=>(
<div key={i} style={{display:'flex',justifyContent:'space-between',padding:'2px 0',borderBottom:'1px solid #f1f5f9',color:h.type==='in'?C.green:C.red}}>
<span>{h.type==='in'?'+':'-'}{h.liters}L {h.date}</span>
<span>{h.type==='out'?h.employeeName+' '+h.machineName:fmtMoney(h.pricePerL)+'/L'}</span>
</div>))}
</div></div>))}
{show&&sel&&<Mod title={sel.name||'Nouveau depot'} onClose={close} width={550}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Adresse"><input style={inputStyle} value={sel.address||''} onChange={e=>setSel({...sel,address:e.target.value})}/></Fl>
<Fl label="GPS (lat,lon)"><input style={inputStyle} value={sel._coords?sel._coords.join(','):''} onChange={e=>{const p=parseCoords(e.target.value);setSel({...sel,_coords:p})}}/></Fl>
<h4 style={{marginTop:12}}>Approvisionnement GNR</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Stock (L)"><input type="number" style={inputStyle} value={sel.gnrStock||0} onChange={e=>setSel({...sel,gnrStock:Number(e.target.value)})}/></Fl>
<Fl label="Prix/L"><input type="number" step="0.01" style={inputStyle} value={sel.gnrPrice||0} onChange={e=>setSel({...sel,gnrPrice:Number(e.target.value)})}/></Fl>
</div>
<h4 style={{marginTop:12}}>Approvisionnement Gazole</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Stock (L)"><input type="number" style={inputStyle} value={sel.gazoleStock||0} onChange={e=>setSel({...sel,gazoleStock:Number(e.target.value)})}/></Fl>
<Fl label="Prix/L"><input type="number" step="0.01" style={inputStyle} value={sel.gazolePrice||0} onChange={e=>setSel({...sel,gazolePrice:Number(e.target.value)})}/></Fl>
</div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== MACHINES ========
const MachinesPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const types=['Raboteuse','Balayeuse','Citerne'];
const open=m=>{setSel(m?{...m}:{id:uid(),name:'',type:'Raboteuse',width:'',fuelConsumption:'',purchasePrice:'',creditMonthly:'',creditEnd:''});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const ms=data.machines||[];const idx=ms.findIndex(m=>m.id===sel.id);const nm=idx>=0?ms.map(m=>m.id===sel.id?sel:m):[...ms,sel];save({...data,machines:nm});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,machines:(data.machines||[]).filter(m=>m.id!==sel.id)});close()};
const driver=mid=>{const e=(data.employees||[]).find(e=>e.machineId===mid);return e?e.name:'-'};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Machines</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
{types.map(t=>{const list=(data.machines||[]).filter(m=>m.type===t);if(!list.length)return null;return(
<div key={t} style={{marginBottom:24}}><h3 style={{color:MC[t],marginBottom:8}}>{t}s</h3>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{list.map(m=>(
<div key={m.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)',borderLeft:'4px solid '+MC[t]}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{m.name}</strong><EBtn onClick={()=>open(m)}/></div>
{t==='Raboteuse'&&m.width&&<div style={{fontSize:13,color:C.dim}}>Largeur: {m.width}</div>}
<div style={{fontSize:13,color:C.dim}}>Chauffeur: {driver(m.id)}</div>
<div style={{fontSize:13,color:C.dim}}>Conso: {m.fuelConsumption||0} L/h</div>
</div>))}
</div></div>)})}
{show&&sel&&<Mod title={sel.name||'Nouvelle machine'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Type"><select style={inputStyle} value={sel.type} onChange={e=>setSel({...sel,type:e.target.value})}>{types.map(t=><option key={t} value={t}>{t}</option>)}</select></Fl>
{sel.type==='Raboteuse'&&<Fl label="Largeur"><input style={inputStyle} value={sel.width} onChange={e=>setSel({...sel,width:e.target.value})}/></Fl>}
<Fl label="Conso (L/h)"><input type="number" style={inputStyle} value={sel.fuelConsumption} onChange={e=>setSel({...sel,fuelConsumption:e.target.value})}/></Fl>
<Fl label="Prix achat"><input type="number" style={inputStyle} value={sel.purchasePrice} onChange={e=>setSel({...sel,purchasePrice:e.target.value})}/></Fl>
<Fl label="Credit mensuel"><input type="number" style={inputStyle} value={sel.creditMonthly} onChange={e=>setSel({...sel,creditMonthly:e.target.value})}/></Fl>
<Fl label="Fin credit"><input type="date" style={inputStyle} value={sel.creditEnd||''} onChange={e=>setSel({...sel,creditEnd:e.target.value})}/></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}><h4 style={{margin:'0 0 8px'}}>Couts mensuels</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Assurance (EUR/mois)"><input type="number" style={inputStyle} value={sel.insuranceMonthly||0} onChange={e=>setSel({...sel,insuranceMonthly:Number(e.target.value)})}/></Fl>
<Fl label="CT (EUR/an)"><input type="number" style={inputStyle} value={sel.ctCost||0} onChange={e=>setSel({...sel,ctCost:Number(e.target.value)})}/></Fl>
</div></div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== TRUCKS ========
const TrucksPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const open=t=>{setSel(t?{...t}:{id:uid(),name:'',fuelPer100:'',ctDate:'',vidangeDate:''});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const ts=data.trucks||[];const idx=ts.findIndex(t=>t.id===sel.id);const nt=idx>=0?ts.map(t=>t.id===sel.id?sel:t):[...ts,sel];save({...data,trucks:nt});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,trucks:(data.trucks||[]).filter(t=>t.id!==sel.id)});close()};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Camions</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.trucks||[]).map(t=>(
<div key={t.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{t.name}</strong><EBtn onClick={()=>open(t)}/></div>
<div style={{fontSize:13,color:C.dim}}>Conso: {t.fuelPer100||0} L/100km</div>
<div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}><CtBadge dateStr={t.ctDate} label="CT"/><CtBadge dateStr={t.vidangeDate} label="Vidange"/></div>
</div>))}
</div>
{show&&sel&&<Mod title={sel.name||'Nouveau camion'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Conso (L/100km)"><input type="number" style={inputStyle} value={sel.fuelPer100} onChange={e=>setSel({...sel,fuelPer100:e.target.value})}/></Fl>
<Fl label="Date CT"><input type="date" style={inputStyle} value={sel.ctDate||''} onChange={e=>setSel({...sel,ctDate:e.target.value})}/></Fl>
<Fl label="Date vidange"><input type="date" style={inputStyle} value={sel.vidangeDate||''} onChange={e=>setSel({...sel,vidangeDate:e.target.value})}/></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}><h4 style={{margin:'0 0 8px'}}>Couts mensuels</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Credit mensuel"><input type="number" style={inputStyle} value={sel.creditMonthly||0} onChange={e=>setSel({...sel,creditMonthly:Number(e.target.value)})}/></Fl>
<Fl label="Assurance (EUR/mois)"><input type="number" style={inputStyle} value={sel.insuranceMonthly||0} onChange={e=>setSel({...sel,insuranceMonthly:Number(e.target.value)})}/></Fl>
<Fl label="CT (EUR/an)"><input type="number" style={inputStyle} value={sel.ctCost||0} onChange={e=>setSel({...sel,ctCost:Number(e.target.value)})}/></Fl>
</div></div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== CARS ========
const CarsPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const open=c=>{setSel(c?{...c}:{id:uid(),name:'',plate:'',ctDate:'',vidangeDate:''});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const cs=data.cars||[];const idx=cs.findIndex(c=>c.id===sel.id);const nc=idx>=0?cs.map(c=>c.id===sel.id?sel:c):[...cs,sel];save({...data,cars:nc});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,cars:(data.cars||[]).filter(c=>c.id!==sel.id)});close()};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Voitures</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.cars||[]).map(c=>(
<div key={c.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{c.name}</strong><EBtn onClick={()=>open(c)}/></div>
<div style={{fontSize:13,color:C.dim}}>Plaque: {c.plate||'-'}</div>
<div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}><CtBadge dateStr={c.ctDate} label="CT"/><CtBadge dateStr={c.vidangeDate} label="Vidange"/></div>
</div>))}
</div>
{show&&sel&&<Mod title={sel.name||'Nouveau vehicule'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Immatriculation"><input style={inputStyle} value={sel.plate||''} onChange={e=>setSel({...sel,plate:e.target.value})}/></Fl>
<Fl label="Date CT"><input type="date" style={inputStyle} value={sel.ctDate||''} onChange={e=>setSel({...sel,ctDate:e.target.value})}/></Fl>
<Fl label="Date vidange"><input type="date" style={inputStyle} value={sel.vidangeDate||''} onChange={e=>setSel({...sel,vidangeDate:e.target.value})}/></Fl>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== EMPLOYEES ========
const EmployeesPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const genLogin=n=>(n||'').toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
const open=e=>{if(e){setSel({...e,_coords:e._coords||null,password:(data.empPasswords||{})[e.id]||''})}else{setSel({id:uid(),name:'',role:'employee',address:'',_coords:null,hourlySalary:'',machineId:'',truckId:'',password:''})}setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const{password,...emp}=sel;emp.login=genLogin(emp.name);const es=data.employees||[];const idx=es.findIndex(e=>e.id===emp.id);const ne=idx>=0?es.map(e=>e.id===emp.id?emp:e):[...es,emp];const ps={...(data.empPasswords||{})};if(password)ps[emp.id]=password;else delete ps[emp.id];save({...data,employees:ne,empPasswords:ps});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;const ps={...(data.empPasswords||{})};delete ps[sel.id];save({...data,employees:(data.employees||[]).filter(e=>e.id!==sel.id),empPasswords:ps});close()};
const machName=mid=>{const m=(data.machines||[]).find(m=>m.id===mid);return m?m.name:'-'};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Employes</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.employees||[]).map(e=>{const has=!!(data.empPasswords||{})[e.id];return(
<div key={e.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',alignItems:'center',gap:12}}>
<div style={{width:40,height:40,borderRadius:'50%',background:C.accent,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:18,flexShrink:0}}>{(e.name||'?')[0].toUpperCase()}</div>
<div style={{flex:1,minWidth:0}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{e.name}</strong><EBtn onClick={()=>open(e)}/></div>
<div style={{fontSize:13,color:C.dim}}>{e.salaryType==='monthly'?fmtMoney(e.monthlySalary||0)+'/mois':fmtMoney(e.hourlySalary||0)+'/h'}</div>
</div></div>
<div style={{fontSize:13,color:C.dim,marginTop:6}}>Machine: {machName(e.machineId)}</div>
<div style={{marginTop:6}}>{has?<Bg text="Actif" color={C.green}/>:<Bg text="Pas d'acces" color={C.red}/>}</div>
</div>)})}
</div>
{show&&sel&&<Mod title={sel.name||'Nouvel employe'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Role"><select style={inputStyle} value={sel.role} onChange={e=>setSel({...sel,role:e.target.value})}><option value="employee">Employe</option><option value="mechanic">Mecanicien</option></select></Fl>
<Fl label="Adresse"><input style={inputStyle} value={sel.address||''} onChange={e=>setSel({...sel,address:e.target.value})}/></Fl>
<Fl label="GPS domicile (lat,lon)"><input style={inputStyle} value={sel._coords?sel._coords.join(','):''} onChange={e=>{const p=parseCoords(e.target.value);setSel({...sel,_coords:p})}} placeholder="48.8566,2.3522"/></Fl>
<Fl label="Type de salaire"><select style={inputStyle} value={sel.salaryType||'hourly'} onChange={e=>setSel({...sel,salaryType:e.target.value})}><option value="hourly">Horaire (pointage)</option><option value="monthly">Mensualise</option></select></Fl>
{(sel.salaryType||'hourly')==='hourly'&&<Fl label="Taux horaire"><input type="number" style={inputStyle} value={sel.hourlySalary} onChange={e=>setSel({...sel,hourlySalary:e.target.value})}/></Fl>}
{sel.salaryType==='monthly'&&<Fl label="Salaire mensuel brut"><input type="number" style={inputStyle} value={sel.monthlySalary||0} onChange={e=>setSel({...sel,monthlySalary:Number(e.target.value)})}/></Fl>}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Panier repas (EUR/jour)"><input type="number" style={inputStyle} value={sel.mealAllowance||12} onChange={e=>setSel({...sel,mealAllowance:Number(e.target.value)})}/></Fl>
<Fl label="Charges patronales (%)"><input type="number" style={inputStyle} value={sel.chargesRate||45} onChange={e=>setSel({...sel,chargesRate:Number(e.target.value)})}/></Fl>
</div>
<Fl label="Machine"><select style={inputStyle} value={sel.machineId||''} onChange={e=>setSel({...sel,machineId:e.target.value})}><option value="">-- Aucune --</option>{(data.machines||[]).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Fl>
<Fl label="Camion"><select style={inputStyle} value={sel.truckId||''} onChange={e=>setSel({...sel,truckId:e.target.value})}><option value="">-- Aucun --</option>{(data.trucks||[]).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h4 style={{margin:'0 0 8px'}}>Acces salarie</h4>
<Fl label="Identifiant"><input style={{...inputStyle,background:'#f0f0f0'}} readOnly value={genLogin(sel.name)}/></Fl>
<Fl label="Mot de passe"><input style={inputStyle} value={sel.password||''} onChange={e=>setSel({...sel,password:e.target.value})} placeholder="Vide = pas d'acces"/></Fl></div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== CLIENTS ========
const ClientsPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);const[agIn,setAgIn]=useState('');
const open=c=>{setSel(c?{...c,agencies:[...(c.agencies||[])],siteManagers:[...(c.siteManagers||[]).map(s=>({...s}))]}:{id:uid(),name:'',forfaitType:'standard',agencies:[],siteManagers:[]});setShow(true)};
const close=()=>{setShow(false);setSel(null);setAgIn('')};
const doSave=()=>{const cs=data.clients||[];const idx=cs.findIndex(c=>c.id===sel.id);const nc=idx>=0?cs.map(c=>c.id===sel.id?sel:c):[...cs,sel];save({...data,clients:nc});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,clients:(data.clients||[]).filter(c=>c.id!==sel.id)});close()};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Clients</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.clients||[]).map(c=>(
<div key={c.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{c.name}</strong><EBtn onClick={()=>open(c)}/></div>
<div style={{marginTop:6}}><Bg text={c.forfaitType==='specific'?'Specifique':'Standard'} color={c.forfaitType==='specific'?C.purple:C.accent}/></div>
<div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:6}}>{(c.agencies||[]).map((a,i)=><span key={i} style={{fontSize:11,padding:'1px 6px',borderRadius:6,background:'#eee'}}>{a}</span>)}</div>
<div style={{fontSize:13,color:C.dim,marginTop:4}}>{(c.siteManagers||[]).length} chef(s) chantier</div>
</div>))}
</div>
{show&&sel&&<Mod title={sel.name||'Nouveau client'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Type forfait"><select style={inputStyle} value={sel.forfaitType} onChange={e=>setSel({...sel,forfaitType:e.target.value})}><option value="standard">Standard</option><option value="specific">Specifique</option></select></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}><h4 style={{margin:'0 0 8px'}}>Agences</h4>
<div style={{display:'flex',gap:6,marginBottom:8}}><input style={{...inputStyle,flex:1}} value={agIn} onChange={e=>setAgIn(e.target.value)} placeholder="Nom agence" onKeyDown={e=>{if(e.key==='Enter'&&agIn.trim()){setSel({...sel,agencies:[...sel.agencies,agIn.trim()]});setAgIn('')}}}/><button style={btnStyle(C.accent)} onClick={()=>{if(agIn.trim()){setSel({...sel,agencies:[...sel.agencies,agIn.trim()]});setAgIn('')}}}>+</button></div>
{sel.agencies.map((a,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span>{a}</span><button style={{background:'none',border:'none',cursor:'pointer',color:C.red}} onClick={()=>setSel({...sel,agencies:sel.agencies.filter((_,j)=>j!==i)})}>x</button></div>)}
</div>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}><h4 style={{margin:0}}>Chefs chantier</h4><button style={btnStyle(C.accent)} onClick={()=>setSel({...sel,siteManagers:[...sel.siteManagers,{name:'',phone:'',agency:''}]})}>+</button></div>
{sel.siteManagers.map((s,i)=>(
<div key={i} style={{display:'flex',gap:6,alignItems:'center',marginBottom:6,flexWrap:'wrap'}}>
<input style={{...inputStyle,flex:1,minWidth:80}} placeholder="Nom" value={s.name} onChange={e=>{const ns=[...sel.siteManagers];ns[i]={...ns[i],name:e.target.value};setSel({...sel,siteManagers:ns})}}/>
<input style={{...inputStyle,flex:1,minWidth:80}} placeholder="Tel" value={s.phone} onChange={e=>{const ns=[...sel.siteManagers];ns[i]={...ns[i],phone:e.target.value};setSel({...sel,siteManagers:ns})}}/>
<input style={{...inputStyle,flex:1,minWidth:80}} placeholder="Agence" value={s.agency||''} onChange={e=>{const ns=[...sel.siteManagers];ns[i]={...ns[i],agency:e.target.value};setSel({...sel,siteManagers:ns})}}/>
<button style={{background:'none',border:'none',cursor:'pointer',color:C.red}} onClick={()=>setSel({...sel,siteManagers:sel.siteManagers.filter((_,j)=>j!==i)})}>x</button>
</div>))}
</div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== FORFAITS ========
const ForfaitsPage=({data,save})=>{
const clients=(data.clients||[]).filter(c=>c.forfaitType==='specific');
const[tab,setTab]=useState('standard');
const rabWidths=[...new Set((data.machines||[]).filter(m=>m.type==='Raboteuse').map(m=>m.width||'').filter(Boolean))];
if(rabWidths.length===0)rabWidths.push('');
const rabDurees=['2h','4h','6h','8h','Transfert'];
const balDurees=['2h','4h','6h','8h','Transfert'];
const citOpts=['Avec chauffeur','Sans chauffeur'];
const citDurees=['Demi-journee','Journee','Transfert'];
const getVal=(key,dur)=>(data.forfaits[key]||{})[dur]||'';
const setVal=(key,dur,v)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.forfaits)nd.forfaits={};if(!nd.forfaits[key])nd.forfaits[key]={};nd.forfaits[key][dur]=Number(v)||0;save(nd)};
const prefix=tab;
const cellStyle={padding:'4px 6px',border:'1px solid '+C.border,textAlign:'center'};
const hdrStyle={...cellStyle,background:C.bg,fontWeight:600,fontSize:12};
return(
<div>
<h2 style={{marginBottom:16}}>Forfaits</h2>
<div style={{display:'flex',gap:4,marginBottom:16,flexWrap:'wrap'}}>
<button onClick={()=>setTab('standard')} style={btnStyle(C.accent,tab==='standard')}>Standard</button>
{clients.map(c=><button key={c.id} onClick={()=>setTab(c.id)} style={btnStyle(C.purple,tab===c.id)}>{c.name}</button>)}
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<h3 style={{color:MC.Raboteuse,marginBottom:8}}>Raboteuses</h3>
<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
<thead><tr><th style={hdrStyle}>Largeur</th>{rabDurees.map(d=><th key={d} style={hdrStyle}>{d}</th>)}</tr></thead>
<tbody>{rabWidths.map(w=>{const key=prefix+'_rab_'+w;return(
<tr key={w}><td style={hdrStyle}>{w||'N/A'}</td>
{rabDurees.map(d=><td key={d} style={cellStyle}><input type="number" style={{width:70,border:'1px solid #ddd',borderRadius:4,padding:2,textAlign:'center'}} value={getVal(key,d)} onChange={e=>setVal(key,d,e.target.value)}/></td>)}
</tr>)})}</tbody></table></div></div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<h3 style={{color:MC.Balayeuse,marginBottom:8}}>Balayeuses</h3>
<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
<thead><tr><th style={hdrStyle}></th>{balDurees.map(d=><th key={d} style={hdrStyle}>{d}</th>)}</tr></thead>
<tbody><tr><td style={hdrStyle}>Prix</td>{balDurees.map(d=>{const key=prefix+'_bal';return(<td key={d} style={cellStyle}><input type="number" style={{width:70,border:'1px solid #ddd',borderRadius:4,padding:2,textAlign:'center'}} value={getVal(key,d)} onChange={e=>setVal(key,d,e.target.value)}/></td>)})}</tr></tbody></table></div></div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border}}>
<h3 style={{color:MC.Citerne,marginBottom:8}}>Citernes</h3>
<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
<thead><tr><th style={hdrStyle}>Option</th>{citDurees.map(d=><th key={d} style={hdrStyle}>{d}</th>)}</tr></thead>
<tbody>{citOpts.map(o=>{const key=prefix+'_cit_'+o;return(
<tr key={o}><td style={hdrStyle}>{o}</td>
{citDurees.map(d=><td key={d} style={cellStyle}><input type="number" style={{width:70,border:'1px solid #ddd',borderRadius:4,padding:2,textAlign:'center'}} value={getVal(key,d)} onChange={e=>setVal(key,d,e.target.value)}/></td>)}
</tr>)})}</tbody></table></div></div>
<div style={{marginTop:8,fontSize:12,color:C.dim}}>Majoration nuit: +{data.nightPct||30}% (configurable dans Parametres)</div>
</div>)};

// ======== SETTINGS ========
const SettingsPage=({data,save})=>{
const[au,setAu]=useState(data.adminUser||'admin');const[ap,setAp]=useState(data.adminPass||'admin');
const[fp,setFp]=useState(data.fuelPrice||1.72);const[np,setNp]=useState(data.nightPct||30);
const[tpDepartMin,setTpDepartMin]=useState(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const[tpArriveeMin,setTpArriveeMin]=useState(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const[tolMin,setTolMin]=useState(data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES);
const[wdpm,setWdpm]=useState(data.workDaysPerMonth||22);
const[mRent,setMRent]=useState(data.monthlyRent||0);
const[mAdmin,setMAdmin]=useState(data.monthlyAdmin||0);
const[mIRC,setMIRC]=useState(data.monthlyInsuranceRC||0);
const[yStart,setYStart]=useState(data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1)));
const[weeklyH,setWeeklyH]=useState(data.weeklyHoursNormal||35);
const[ot25,setOt25]=useState(data.overtime25Threshold||35);
const[ot50,setOt50]=useState(data.overtime50Threshold||43);
const[refHpd,setRefHpd]=useState(data.refHoursPerDay||1);
const doSave=()=>{save({...data,adminUser:au,adminPass:ap,fuelPrice:Number(fp),nightPct:Number(np),tempsPlusDepart:Number(tpDepartMin),tempsPlusArrivee:Number(tpArriveeMin),toleranceMinutes:Number(tolMin),workDaysPerMonth:Number(wdpm),monthlyRent:Number(mRent),monthlyAdmin:Number(mAdmin),monthlyInsuranceRC:Number(mIRC),yearStart:yStart,weeklyHoursNormal:Number(weeklyH),overtime25Threshold:Number(ot25),overtime50Threshold:Number(ot50),refHoursPerDay:Number(refHpd)});alert('Enregistre')};
const genLogin=n=>(n||'').toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
return(
<div>
<h2 style={{marginBottom:16}}>Parametres</h2>
<div style={{background:C.card,borderRadius:12,padding:20,border:'1px solid '+C.border,maxWidth:600}}>
<h3 style={{marginTop:0}}>Compte admin</h3>
<Fl label="Identifiant"><input style={inputStyle} value={au} onChange={e=>setAu(e.target.value)}/></Fl>
<Fl label="Mot de passe"><input style={inputStyle} type="password" value={ap} onChange={e=>setAp(e.target.value)}/></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Tarification</h3>
<Fl label="Prix carburant (EUR/L)"><input type="number" step="0.01" style={inputStyle} value={fp} onChange={e=>setFp(e.target.value)}/></Fl>
<Fl label="Majoration nuit (%)"><input type="number" style={inputStyle} value={np} onChange={e=>setNp(e.target.value)}/></Fl></div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Constantes horaires</h3>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Temps en plus depart (min)"><input type="number" style={inputStyle} value={tpDepartMin} onChange={e=>setTpDepartMin(e.target.value)}/></Fl>
<Fl label="Temps en plus arrivee (min)"><input type="number" style={inputStyle} value={tpArriveeMin} onChange={e=>setTpArriveeMin(e.target.value)}/></Fl>
<Fl label="Tolerance (min)"><input type="number" style={inputStyle} value={tolMin} onChange={e=>setTolMin(e.target.value)}/></Fl>
</div></div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Heures supplementaires</h3>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Heures normales/semaine"><input type="number" style={inputStyle} value={weeklyH} onChange={e=>setWeeklyH(e.target.value)}/></Fl>
<Fl label="Seuil supp 25% (h)"><input type="number" style={inputStyle} value={ot25} onChange={e=>setOt25(e.target.value)}/></Fl>
<Fl label="Seuil supp 50% (h)"><input type="number" style={inputStyle} value={ot50} onChange={e=>setOt50(e.target.value)}/></Fl>
<Fl label="Temps ref/jour (h)"><input type="number" step="0.25" style={inputStyle} value={refHpd} onChange={e=>setRefHpd(e.target.value)}/></Fl>
</div></div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Couts fixes entreprise</h3>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Jours ouvres/mois"><input type="number" style={inputStyle} value={wdpm} onChange={e=>setWdpm(e.target.value)}/></Fl>
<Fl label="Loyer/credit depot (EUR/mois)"><input type="number" style={inputStyle} value={mRent} onChange={e=>setMRent(e.target.value)}/></Fl>
<Fl label="Frais admin/comptable (EUR/mois)"><input type="number" style={inputStyle} value={mAdmin} onChange={e=>setMAdmin(e.target.value)}/></Fl>
<Fl label="Assurance RC pro (EUR/mois)"><input type="number" style={inputStyle} value={mIRC} onChange={e=>setMIRC(e.target.value)}/></Fl>
</div>
<Fl label="Debut exercice"><input type="date" style={inputStyle} value={yStart} onChange={e=>setYStart(e.target.value)}/></Fl>
</div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Acces employes</h3>
{(data.employees||[]).map(e=>{const has=!!(data.empPasswords||{})[e.id];return(
<div key={e.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:'1px solid #f0f0f0'}}>
<div><span style={{fontWeight:500}}>{e.name}</span><span style={{fontSize:12,color:C.muted,marginLeft:8}}>({genLogin(e.name)})</span></div>
<span style={{fontSize:12,padding:'2px 8px',borderRadius:8,background:has?'#d4edda':'#f8d7da',color:has?'#155724':'#721c24'}}>{has?'Actif':'Inactif'}</span>
</div>)})}
</div>
<button onClick={doSave} style={{...btnStyle(C.accent,true),marginTop:16}}>Enregistrer</button>
</div></div>)};

// ======== EMPLOYEE VIEW ========
const EmployeeView=({data,save,empId,onLogout})=>{
const emp=(data.employees||[]).find(e=>e.id===empId);
const[view,setView]=useState('Jour');const[offset,setOffset]=useState(0);
const[editTE,setEditTE]=useState(null);
const[showManual,setShowManual]=useState(false);
const[manDate,setManDate]=useState(fmtDateISO(new Date()));
const[manStart,setManStart]=useState('');
const[manEnd,setManEnd]=useState('');
const[manPause,setManPause]=useState(0);
const[manBreakStart,setManBreakStart]=useState('12:00');
const[manBreakEnd,setManBreakEnd]=useState('13:00');
const[manMeal,setManMeal]=useState('PANIER');
const[manAbsence,setManAbsence]=useState('');
const[manNight,setManNight]=useState(0);
const[showPanne,setShowPanne]=useState(false);
const[panneEquip,setPanneEquip]=useState('');
const[panneEquipType,setPanneEquipType]=useState('machine');
const[panneSev,setPanneSev]=useState('normal');
const[panneDesc,setPanneDesc]=useState('');
const[showTakePart,setShowTakePart]=useState(false);
const[takePartType,setTakePartType]=useState('');
const[takePartId,setTakePartId]=useState('');
const[takePartQte,setTakePartQte]=useState(1);
const[takePartReason,setTakePartReason]=useState('');
const allEquipEmp=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'machine'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'camion'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'voiture'}))];
const submitPanne=()=>{if(!panneEquip||!panneDesc){alert('Equipement et description requis');return}const nd=JSON.parse(JSON.stringify(data));if(!nd.panneReports)nd.panneReports=[];const eq=allEquipEmp.find(x=>x.id===panneEquip);const rep={id:uid(),date:fmtDateISO(new Date()),reportedBy:empId,severity:panneSev,status:'new',description:panneDesc};if(eq){if(eq.t==='machine')rep.machineId=eq.id;else if(eq.t==='camion')rep.truckId=eq.id;else rep.carId=eq.id}nd.panneReports.push(rep);save(nd);setShowPanne(false);setPanneEquip('');setPanneDesc('');setPanneSev('normal');alert('Panne signalee !')};
const[takePartEquip,setTakePartEquip]=useState('');
const empMachines=useMemo(()=>{const today2=fmtDateISO(new Date());const todayJobs=(data.jobs||[]).filter(j=>j.employeeId===empId&&j.date===today2);const machIds=[...new Set(todayJobs.map(j=>j.machineId).filter(Boolean))];const truckId=emp?emp.truckId:null;return[...machIds.map(id=>{const m=(data.machines||[]).find(x=>x.id===id);return m?{id:m.id,name:m.name,t:'machine'}:null}).filter(Boolean),...(truckId?[{id:truckId,name:((data.trucks||[]).find(t=>t.id===truckId)||{}).name||'Camion',t:'camion'}]:[])]},[data,empId,emp]);
const availPartsForEmp=useMemo(()=>(data.parts||[]).filter(p=>p.quantity>0&&(!takePartEquip||(p.compatibleWith||[]).length===0||(p.compatibleWith||[]).includes(takePartEquip))),[data.parts,takePartEquip]);
const submitTakePart=()=>{if(!takePartId){alert('Choisir une piece');return}const nd=JSON.parse(JSON.stringify(data));const part=(nd.parts||[]).find(p=>p.id===takePartId);if(!part){alert('Piece non trouvee');return}if(part.quantity<takePartQte){alert('Stock insuffisant (dispo: '+part.quantity+')');return}part.quantity-=takePartQte;if(!part.history)part.history=[];part.history.unshift({type:'out',quantity:takePartQte,date:fmtDateISO(new Date()),reason:takePartReason||'Prise par chauffeur',by:empId});part.history=part.history.slice(0,50);if(!nd.interventions)nd.interventions=[];const eq=takePartEquip?allEquipEmp.find(x=>x.id===takePartEquip):null;const inter={id:uid(),date:fmtDateISO(new Date()),type:'changement_piece',description:'Piece prise par '+(emp?emp.name:'chauffeur')+': '+part.name+(takePartReason?' - '+takePartReason:''),employeeId:empId,partsUsed:[{partId:part.id,partName:part.name,quantity:takePartQte,unitPrice:part.unitPrice,totalPrice:takePartQte*part.unitPrice}],laborHours:0,laborCost:0,totalCost:takePartQte*part.unitPrice,status:'done',notes:'Auto-cree depuis espace chauffeur'};if(eq){if(eq.t==='machine')inter.machineId=eq.id;else if(eq.t==='camion')inter.truckId=eq.id;else inter.carId=eq.id}nd.interventions.push(inter);save(nd);setShowTakePart(false);setTakePartId('');setTakePartQte(1);setTakePartReason('');setTakePartEquip('');setTakePartType('');alert('Piece prise du stock !')};
const today=fmtDateISO(new Date());
const dayEntries=(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date===today);
const lastEntry=dayEntries[dayEntries.length-1];
const status=!lastEntry||lastEntry.type==='done'?'off':lastEntry.type==='pause_start'?'pause':'on';
const doTime=(type)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntries)nd.timeEntries=[];const now=new Date();const time=pad2(now.getHours())+':'+pad2(now.getMinutes());
if(type==='start'){nd.timeEntries.push({id:uid(),empId,date:today,type:'start',startTime:time,endTime:null,pauseStart:null,pauseEnd:null,pauseMin:0,createdAt:new Date().toISOString(),breakStart:'',breakEnd:'',mealType:'PANIER',absenceType:'',nightHours:0})}
else if(type==='pause_start'&&lastEntry){const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.type='pause_start';e.pauseStart=time;e.breakStart=time}}
else if(type==='resume'&&lastEntry){const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.type='start';if(e.pauseStart){const[ph,pm]=e.pauseStart.split(':').map(Number);const[nh,nm]=time.split(':').map(Number);e.pauseMin=(e.pauseMin||0)+(nh*60+nm)-(ph*60+pm)}e.pauseEnd=time;e.breakEnd=time;e.pauseStart=null}}
else if(type==='done'&&lastEntry){const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.type='done';e.endTime=time;if(e.pauseStart){const[ph,pm]=e.pauseStart.split(':').map(Number);const[nh,nm]=time.split(':').map(Number);e.pauseMin=(e.pauseMin||0)+(nh*60+nm)-(ph*60+pm);e.pauseStart=null}}}
save(nd)};
const saveManual=()=>{if(!manAbsence&&(!manStart||!manEnd))return;if(manStart&&manEnd){const[sh,sm]=manStart.split(':').map(Number);const[eh,em]=manEnd.split(':').map(Number);const startMin=sh*60+sm;const endMin=eh*60+em;if(startMin>=endMin){alert('Embauche doit etre avant debauche');return}const totalMin=endMin-startMin;if(Number(manPause)>=totalMin){alert('Pause trop longue');return}}const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntries)nd.timeEntries=[];const existing=nd.timeEntries.findIndex(t=>t.empId===empId&&t.date===manDate);const entry={id:existing>=0?nd.timeEntries[existing].id:uid(),empId,date:manDate,type:manAbsence?'absence':'done',startTime:manStart||'',endTime:manEnd||'',pauseStart:null,pauseEnd:null,pauseMin:Number(manPause)||0,createdAt:new Date().toISOString(),breakStart:manBreakStart,breakEnd:manBreakEnd,mealType:manMeal,absenceType:manAbsence,nightHours:Number(manNight)||0};if(existing>=0)nd.timeEntries[existing]=entry;else nd.timeEntries.push(entry);save(nd);setShowManual(false);setManStart('');setManEnd('');setManPause(0);setManBreakStart('12:00');setManBreakEnd('13:00');setManMeal('PANIER');setManAbsence('');setManNight(0)};
const hist30=useMemo(()=>{const now=new Date();const d30=new Date(now);d30.setDate(d30.getDate()-30);const start30=fmtDateISO(d30);const end30=fmtDateISO(now);return(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=start30&&t.date<=end30).sort((a,b)=>b.date.localeCompare(a.date))},[data.timeEntries,empId]);
const range=useMemo(()=>{const now=new Date();if(view==='Jour'){const d=new Date(now);d.setDate(d.getDate()+offset);return{start:fmtDateISO(d),end:fmtDateISO(d),label:fmtDate(d)}}const d=new Date(now);d.setDate(d.getDate()+offset*7);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const mon=new Date(d);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);return{start:fmtDateISO(mon),end:fmtDateISO(sun),label:fmtDate(mon)+' - '+fmtDate(sun)}},[view,offset]);
const periodTE=(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=range.start&&t.date<=range.end);
const periodJobs=(data.jobs||[]).filter(j=>j.employeeId===empId&&j.date>=range.start&&j.date<=range.end);
let totalWork=0,totalPause=0;periodTE.forEach(t=>{if(t.startTime&&t.endTime){const[sh,sm]=t.startTime.split(':').map(Number);const[eh,em]=t.endTime.split(':').map(Number);totalWork+=(eh*60+em)-(sh*60+sm)-(t.pauseMin||0);totalPause+=(t.pauseMin||0)}});
const weeklyTotal=useMemo(()=>{const now=new Date();const day=now.getDay();const diff=now.getDate()-day+(day===0?-6:1);const mon=new Date(now);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);const ws=fmtDateISO(mon);const we=fmtDateISO(sun);let wt=0;(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=ws&&t.date<=we).forEach(t=>{if(t.startTime&&t.endTime){const[sh,sm]=t.startTime.split(':').map(Number);const[eh,em]=t.endTime.split(':').map(Number);wt+=(eh*60+em)-(sh*60+sm)-(t.pauseMin||0)}});return wt},[data.timeEntries,empId]);
const monthlyTotal=useMemo(()=>{const now=new Date();const ms=now.getFullYear()+'-'+pad2(now.getMonth()+1)+'-01';const last=new Date(now.getFullYear(),now.getMonth()+1,0);const me=fmtDateISO(last);let mt=0;(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=ms&&t.date<=me).forEach(t=>{if(t.startTime&&t.endTime){const[sh,sm]=t.startTime.split(':').map(Number);const[eh,em]=t.endTime.split(':').map(Number);mt+=(eh*60+em)-(sh*60+sm)-(t.pauseMin||0)}});return mt},[data.timeEntries,empId]);
const dates=[...new Set([...periodTE.map(t=>t.date),...periodJobs.map(j=>j.date)])].sort().reverse();
const saveEdit=()=>{if(!editTE)return;const nd=JSON.parse(JSON.stringify(data));const idx=nd.timeEntries.findIndex(t=>t.id===editTE.id);if(idx>=0)nd.timeEntries[idx]=editTE;save(nd);setEditTE(null)};
const delTE=(tid)=>{if(!confirm('Supprimer ?'))return;const nd=JSON.parse(JSON.stringify(data));nd.timeEntries=nd.timeEntries.filter(t=>t.id!==tid);save(nd)};
if(!emp)return(<div style={{fontSize:14}}>Employe non trouve</div>);
return(
<div style={{maxWidth:700,margin:'0 auto',padding:16,fontSize:14}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,background:C.accent,color:'#fff',padding:'12px 16px',borderRadius:10}}>
<div style={{display:'flex',alignItems:'center',gap:10}}>
<div style={{width:40,height:40,borderRadius:'50%',background:'#fff3',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:18}}>{(emp.name||'?')[0].toUpperCase()}</div>
<div><div style={{fontWeight:700,fontSize:18}}>{emp.name}</div><div style={{fontSize:14,opacity:.8}}>Espace chauffeur</div></div>
</div>
<div style={{display:'flex',gap:6}}><button onClick={()=>{loadData().then(d2=>{if(d2){save(d2);alert('Actualisé !')}})}} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>↻</button><button onClick={onLogout} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>Deconnexion</button></div>
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
<h3 style={{margin:0,fontSize:18}}>Pointage - {fmtDate(new Date())}</h3>
<div style={{width:14,height:14,borderRadius:'50%',background:status==='on'?C.green:status==='pause'?C.orange:C.muted}}/>
</div>
<div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
{status==='off'&&<button onClick={()=>doTime('start')} style={{...btnStyle(C.green,true),fontSize:16,padding:'10px 18px'}}>Debut de journee</button>}
{status==='on'&&<button onClick={()=>doTime('pause_start')} style={{...btnStyle(C.orange,true),fontSize:16,padding:'10px 18px'}}>Pause</button>}
{status==='on'&&<button onClick={()=>doTime('done')} style={{...btnStyle(C.red,true),fontSize:16,padding:'10px 18px'}}>Fin de journee</button>}
{status==='pause'&&<button onClick={()=>doTime('resume')} style={{...btnStyle(C.green,true),fontSize:16,padding:'10px 18px'}}>Reprise</button>}
</div>
{status!=='off'&&lastEntry&&<div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center'}}>
<span style={{fontSize:13,color:C.dim}}>Repas :</span>
{['PANIER','RESTO'].map(m=><button key={m} onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.mealType=m;save(nd)}}} style={{...btnStyle(m==='PANIER'?C.accent:C.orange,lastEntry.mealType===m),padding:'4px 12px',fontSize:12}}>{m}</button>)}
</div>}
<button onClick={()=>{setShowManual(true);setManDate(today);setManStart('');setManEnd('');setManPause(0)}} style={{...btnStyle(C.accent),fontSize:14,marginBottom:12}}>Saisir mes heures</button>
{dayEntries.map(t=>(<div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:14,borderBottom:'1px solid #f1f5f9'}}>
<span style={{fontWeight:600,fontSize:16}}>{t.startTime} - {t.endTime||'...'} {t.pauseMin>0&&<Bg text={'pause: '+t.pauseMin+'min'} color={C.orange}/>}</span>
<div style={{display:'flex',gap:4}}>
{t.date===today&&<button onClick={()=>setEditTE({...t})} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.accent}}>&#9998;</button>}
{t.date===today&&<button onClick={()=>delTE(t.id)} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.red}}>x</button>}
</div></div>))}
</div>
{showManual&&<Mod title="Saisir mes heures" onClose={()=>setShowManual(false)} width={450}>
<Fl label="Date"><input type="date" style={inputStyle} value={manDate} onChange={e=>setManDate(e.target.value)}/></Fl>
<Fl label="Absence"><select style={inputStyle} value={manAbsence} onChange={e=>setManAbsence(e.target.value)}><option value="">Pas d'absence</option><option value="maladie">Maladie</option><option value="conge">Conge</option><option value="rtt">RTT</option><option value="autre">Autre</option></select></Fl>
{!manAbsence&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Embauche"><input type="time" style={inputStyle} value={manStart} onChange={e=>setManStart(e.target.value)}/></Fl>
<Fl label="Debauche"><input type="time" style={inputStyle} value={manEnd} onChange={e=>setManEnd(e.target.value)}/></Fl>
<Fl label="Coupure (debut)"><input type="time" style={inputStyle} value={manBreakStart} onChange={e=>setManBreakStart(e.target.value)}/></Fl>
<Fl label="Reprise"><input type="time" style={inputStyle} value={manBreakEnd} onChange={e=>setManBreakEnd(e.target.value)}/></Fl>
</div>}
{!manAbsence&&<Fl label="Repas"><div style={{display:'flex',gap:8}}>{['PANIER','RESTO'].map(m=><button key={m} onClick={()=>setManMeal(m)} style={{...btnStyle(m==='PANIER'?C.accent:C.orange,manMeal===m),padding:'4px 12px',fontSize:12}}>{m}</button>)}</div></Fl>}
{!manAbsence&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Pause (min)"><input type="number" style={inputStyle} value={manPause} onChange={e=>setManPause(e.target.value)}/></Fl>
<Fl label="Heures nuit"><input type="number" step="0.25" style={inputStyle} value={manNight} onChange={e=>setManNight(e.target.value)}/></Fl>
</div>}
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={saveManual} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>setShowManual(false)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
{editTE&&<Mod title="Modifier pointage" onClose={()=>setEditTE(null)}>
<Fl label="Debut"><input type="time" style={inputStyle} value={editTE.startTime||''} onChange={e=>setEditTE({...editTE,startTime:e.target.value})}/></Fl>
<Fl label="Fin"><input type="time" style={inputStyle} value={editTE.endTime||''} onChange={e=>setEditTE({...editTE,endTime:e.target.value})}/></Fl>
<Fl label="Pause (min)"><input type="number" style={inputStyle} value={editTE.pauseMin||0} onChange={e=>setEditTE({...editTE,pauseMin:Number(e.target.value)})}/></Fl>
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={saveEdit} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>setEditTE(null)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
<div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
<button onClick={()=>setShowPanne(true)} style={{...btnStyle(C.red,true),fontSize:14}}>&#9888; Signaler une panne</button>
<button onClick={()=>setShowTakePart(true)} style={{...btnStyle(C.cyan,true),fontSize:14}}>&#128295; Prendre une piece</button>
</div>
{showPanne&&<Mod title="Signaler une panne" onClose={()=>setShowPanne(false)}>
<Fl label="Equipement"><select style={inputStyle} value={panneEquip} onChange={e=>setPanneEquip(e.target.value)}><option value="">--</option>{allEquipEmp.map(eq=><option key={eq.id} value={eq.id}>({eq.t}) {eq.name}</option>)}</select></Fl>
<Fl label="Severite"><select style={inputStyle} value={panneSev} onChange={e=>setPanneSev(e.target.value)}>{SEVERITIES.map(s=><option key={s} value={s}>{s}</option>)}</select></Fl>
<Fl label="Description"><textarea style={{...inputStyle,height:80}} value={panneDesc} onChange={e=>setPanneDesc(e.target.value)} placeholder="Decrivez le probleme..."/></Fl>
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={submitPanne} style={btnStyle(C.red,true)}>Envoyer</button><button onClick={()=>setShowPanne(false)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
{showTakePart&&<Mod title="Prendre une piece" onClose={()=>setShowTakePart(false)}>
<Fl label="Type de machine"><div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
{['Raboteuse','Balayeuse','Citerne'].map(t=><button key={t} onClick={()=>{setTakePartType(t);setTakePartEquip('');setTakePartId('')}} style={{...btnStyle(MC[t]||C.accent,takePartType===t),padding:'8px 16px',fontSize:15}}>{t}</button>)}
</div></Fl>
{takePartType&&<Fl label={takePartType+' - choisir'}><select style={inputStyle} value={takePartEquip} onChange={e=>{setTakePartEquip(e.target.value);setTakePartId('')}}>
<option value="">-- Choisir --</option>{(data.machines||[]).filter(mx=>mx.type===takePartType).map(mx=><option key={mx.id} value={mx.id}>{mx.name}</option>)}
</select></Fl>}
{takePartEquip&&<Fl label="Piece"><select style={inputStyle} value={takePartId} onChange={e=>setTakePartId(e.target.value)}><option value="">--</option>{availPartsForEmp.map(p=><option key={p.id} value={p.id}>{p.name} ({p.category}) - stock: {p.quantity}</option>)}</select></Fl>}
{takePartEquip&&<Fl label="Quantite"><input type="number" style={inputStyle} min="1" value={takePartQte} onChange={e=>setTakePartQte(Number(e.target.value)||1)}/></Fl>}
{takePartEquip&&<Fl label="Raison"><input style={inputStyle} value={takePartReason} onChange={e=>setTakePartReason(e.target.value)} placeholder="Remplacement, reparation..."/></Fl>}
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={submitTakePart} style={btnStyle(C.cyan,true)}>Confirmer</button><button onClick={()=>setShowTakePart(false)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
<div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,flexWrap:'wrap'}}>
{['Jour','Semaine'].map(v=><button key={v} onClick={()=>{setView(v);setOffset(0)}} style={{...btnStyle(C.accent,view===v),fontSize:14}}>{v}</button>)}
<button onClick={()=>setOffset(o=>o-1)} style={btnStyle(C.dim)}>{'<'}</button><span style={{fontWeight:600,fontSize:14}}>{range.label}</span><button onClick={()=>setOffset(o=>o+1)} style={btnStyle(C.dim)}>{'>'}</button>
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:16}}>
<div style={{background:C.card,borderRadius:10,padding:12,border:'1px solid '+C.border,textAlign:'center'}}><div style={{fontSize:14,color:C.dim}}>Travail</div><div style={{fontSize:18,fontWeight:800,color:C.accent}}>{fmtDuration(totalWork)}</div></div>
<div style={{background:C.card,borderRadius:10,padding:12,border:'1px solid '+C.border,textAlign:'center'}}><div style={{fontSize:14,color:C.dim}}>Pause</div><div style={{fontSize:18,fontWeight:800,color:C.orange}}>{fmtDuration(totalPause)}</div></div>
<div style={{background:C.card,borderRadius:10,padding:12,border:'1px solid '+C.border,textAlign:'center'}}><div style={{fontSize:14,color:C.dim}}>Missions</div><div style={{fontSize:18,fontWeight:800,color:C.text}}>{periodJobs.length}</div></div>
</div>
{dates.map(date=>{const tes=periodTE.filter(t=>t.date===date);const jbs=periodJobs.filter(j=>j.date===date);return(
<div key={date} style={{background:C.card,borderRadius:10,padding:12,marginBottom:10,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:16,marginBottom:6,color:C.accent}}>{fmtDate(new Date(date))}</div>
{tes.map(t=>{let wm=0;if(t.startTime&&t.endTime){const[sh3,sm3]=t.startTime.split(':').map(Number);const[eh3,em3]=t.endTime.split(':').map(Number);wm=(eh3*60+em3)-(sh3*60+sm3)-(t.pauseMin||0)}return(
<div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:14,marginBottom:4,padding:'4px 0',borderBottom:'1px solid #f1f5f9'}}>
<div><span style={{fontWeight:700,fontSize:16}}>{t.startTime} - {t.endTime||'...'}</span>{t.pauseMin>0&&<span style={{marginLeft:6}}><Bg text={'pause '+t.pauseMin+'min'} color={C.orange}/></span>}{wm>0&&<span style={{marginLeft:6,fontWeight:600,color:C.accent}}>{fmtDuration(wm)}</span>}</div>
<button onClick={()=>setEditTE({...t})} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.accent}}>&#9998;</button>
</div>)})}
{jbs.map(j=>{const cl=(data.clients||[]).find(c=>c.id===j.clientId);const m=(data.machines||[]).find(x=>x.id===j.machineId);const depN=j.startFrom==='home'?'Domicile':((data.depots||[]).find(d=>d.id===j.startFrom)||{}).name||'';const arrN=j.endAt==='home'?'Domicile':((data.depots||[]).find(d=>d.id===j.endAt)||{}).name||'';const isDepot=j.type==='depot';const depotObj=isDepot?(data.depots||[]).find(d=>d.id===j.depotId):null;return(
<div key={j.id} style={{background:j.ack?'#dcfce7':isDepot?'#f8fafc':C.card,borderRadius:8,padding:10,marginTop:4,fontSize:14,borderLeft:'3px solid '+(isDepot?'#64748b':m?MC[m.type]||C.accent:C.muted)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
<div style={{fontWeight:700,fontSize:16}}>{isDepot?<span style={{color:'#64748b'}}>{depotObj?depotObj.name:'Depot'} — {j.depotActivity||'Depot'}{j.depotDescription?' ('+j.depotDescription+')':''}</span>:(cl?cl.name:'Pas de client')}{!isDepot&&j.agencyName?' - '+j.agencyName:''}</div>
{!j.ack?<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.ack=true;save(nd)}}} style={{padding:'6px 14px',borderRadius:6,fontSize:14,fontWeight:700,background:C.green,color:'#fff',border:'none',cursor:'pointer'}}>✓ Lu</button>:<span style={{padding:'4px 10px',borderRadius:6,fontSize:13,fontWeight:700,background:'#16a34a20',color:C.green}}>✓ Pris en compte</span>}
</div>
<div style={{fontSize:14,marginTop:2}}>{m&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:(MC[m.type]||C.accent)+'18',color:MC[m.type]||C.accent}}>{m.name} ({m.type})</span>} <span style={{color:C.orange,fontWeight:600,marginLeft:4}}>{j.billingStart}</span> <span style={{color:C.dim}}>{j.forfaitType}</span></div>
{j.siteManager&&<div style={{color:C.dim,fontSize:14,marginTop:2}}>{j.siteManager} {j.siteManagerPhone&&<a href={'tel:'+j.siteManagerPhone} style={{color:C.accent}}>{j.siteManagerPhone}</a>}</div>}
{j.location&&<div style={{fontSize:14,marginTop:2}}>{j.gps?<a href={'https://www.google.com/maps?q='+j.gps} target="_blank" rel="noopener" style={{color:C.accent}}>{j.location}</a>:<span style={{color:C.dim}}>{j.location}</span>}</div>}
{(depN||arrN)&&<div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
{depN&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:'#0891b215',color:'#0891b2'}}>{'↗'} {depN}{j.kmAller>0?' '+j.kmAller.toFixed(0)+'km':''}</span>}
{arrN&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:'#7c3aed15',color:'#7c3aed'}}>{'↙'} {arrN}{j.kmRetour>0?' '+j.kmRetour.toFixed(0)+'km':''}</span>}
</div>}
</div>)})}
</div>)})}
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginTop:16}}>
<h3 style={{margin:'0 0 12px',fontSize:18}}>Historique 30 jours</h3>
{hist30.length===0&&<div style={{fontSize:14,color:C.dim}}>Aucun pointage</div>}
{hist30.map(t=>{let wm2=0;if(t.startTime&&t.endTime){const[sh4,sm4]=t.startTime.split(':').map(Number);const[eh4,em4]=t.endTime.split(':').map(Number);wm2=(eh4*60+em4)-(sh4*60+sm4)-(t.pauseMin||0)}return(
<div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:14,borderBottom:'1px solid #f1f5f9'}}>
<div><span style={{fontWeight:600,fontSize:14}}>{fmtDate(new Date(t.date))}</span></div>
<div style={{display:'flex',gap:8,alignItems:'center'}}>
<span style={{fontWeight:700,fontSize:16}}>{t.startTime||'--'} - {t.endTime||'--'}</span>
{t.pauseMin>0&&<Bg text={t.pauseMin+'min pause'} color={C.orange}/>}
{wm2>0&&<span style={{fontWeight:700,color:C.accent}}>{fmtDuration(wm2)}</span>}
<button onClick={()=>setEditTE({...t})} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.accent}}>&#9998;</button>
</div></div>)})}
<div style={{display:'flex',gap:16,marginTop:12,padding:'8px 0',borderTop:'2px solid '+C.border}}>
<div style={{fontSize:14}}><span style={{color:C.dim}}>Semaine: </span><span style={{fontWeight:800,color:C.accent,fontSize:16}}>{fmtDuration(weeklyTotal)}</span></div>
<div style={{fontSize:14}}><span style={{color:C.dim}}>Mois: </span><span style={{fontWeight:800,color:C.green,fontSize:16}}>{fmtDuration(monthlyTotal)}</span></div>
</div>
</div>
</div>)};

// ======== STOCK PIECES ========
const StockPage=({data,save,isAdmin})=>{
const[selDepot,setSelDepot]=useState((data.depots||[])[0]?.id||'');
const[search,setSearch]=useState('');
const[catFilter,setCatFilter]=useState('');
const[showAdd,setShowAdd]=useState(false);
const[sel,setSel]=useState(null);
const blank={name:'',reference:'',category:'pneu',compatibleWith:[],depotId:selDepot,quantity:0,unitPrice:0,minStock:1,supplier:'',history:[]};
const parts=(data.parts||[]).filter(p=>(!selDepot||p.depotId===selDepot)&&(!catFilter||p.category===catFilter)&&(!search||p.name.toLowerCase().includes(search.toLowerCase())||p.reference.toLowerCase().includes(search.toLowerCase())));
const totalVal=parts.reduce((s,p)=>s+(p.quantity||0)*(p.unitPrice||0),0);
const openEdit=p=>{setSel({...p,compatibleWith:[...(p.compatibleWith||[])]});setShowAdd(true)};
const doSave=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.parts)nd.parts=[];const idx=nd.parts.findIndex(p=>p.id===sel.id);if(idx>=0)nd.parts[idx]=sel;else{sel.id=uid();nd.parts.push(sel)}save(nd);setShowAdd(false);setSel(null)};
const doDelete=id=>{if(!confirm('Supprimer ?'))return;save({...data,parts:(data.parts||[]).filter(p=>p.id!==id)})};
const doStockIn=(p)=>{const qte=prompt('Quantite a ajouter ?');if(!qte)return;const n=Number(qte);if(!n||n<=0)return;const nd=JSON.parse(JSON.stringify(data));const pp=nd.parts.find(x=>x.id===p.id);if(pp){pp.quantity=(pp.quantity||0)+n;if(!pp.history)pp.history=[];pp.history.unshift({type:'in',quantity:n,date:fmtDateISO(new Date()),unitPrice:pp.unitPrice});pp.history=pp.history.slice(0,50);save(nd)}};
const doStockOut=(p)=>{const qte=prompt('Quantite a retirer ?');if(!qte)return;const n=Number(qte);if(!n||n<=0)return;if(n>p.quantity){alert('Stock insuffisant');return}const nd=JSON.parse(JSON.stringify(data));const pp=nd.parts.find(x=>x.id===p.id);if(pp){pp.quantity=Math.max(0,pp.quantity-n);if(!pp.history)pp.history=[];pp.history.unshift({type:'out',quantity:n,date:fmtDateISO(new Date())});pp.history=pp.history.slice(0,50);save(nd)}};
const allEquip=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'M'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'C'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'V'}))];
const equipName=id=>{const e=allEquip.find(x=>x.id===id);return e?e.name:'?'};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
<h2 style={{margin:0}}>Stock pieces</h2>
<div style={{display:'flex',gap:6,alignItems:'center'}}>
{isAdmin&&<span style={{fontSize:13,color:C.dim}}>Valeur: <b style={{color:C.accent}}>{fmtMoney(totalVal)}</b></span>}
<button style={btnStyle(C.accent,true)} onClick={()=>{setSel({...blank,depotId:selDepot});setShowAdd(true)}}>+ Ajouter</button>
</div></div>
<div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap',alignItems:'center'}}>
<select style={{...inputStyle,width:160}} value={selDepot} onChange={e=>setSelDepot(e.target.value)}><option value="">Tous depots</option>{(data.depots||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
<input style={{...inputStyle,width:200}} placeholder="Rechercher..." value={search} onChange={e=>setSearch(e.target.value)}/>
<select style={{...inputStyle,width:140}} value={catFilter} onChange={e=>setCatFilter(e.target.value)}><option value="">Toutes</option>{PART_CATS.map(c=><option key={c} value={c}>{c}</option>)}</select>
</div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:12}}>
{parts.map(p=>(
<div key={p.id} style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,borderLeft:'3px solid '+(p.quantity<=(p.minStock||0)?C.red:C.green)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<strong style={{fontSize:14}}>{p.name}</strong>
<div style={{display:'flex',gap:4}}><EBtn onClick={()=>openEdit(p)}/>{isAdmin&&<button onClick={()=>doDelete(p.id)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:14}}>x</button>}</div>
</div>
<div style={{fontSize:12,color:C.dim}}>Ref: {p.reference||'-'} | {p.supplier||'-'} | {p.category}</div>
<div style={{fontSize:13,marginTop:4}}>
<span style={{fontWeight:700,color:p.quantity<=(p.minStock||0)?C.red:C.green}}>Stock: {p.quantity}</span>
<span style={{color:C.dim}}> | {fmtMoney(p.unitPrice)}/u | Val: {fmtMoney(p.quantity*p.unitPrice)}</span>
{p.quantity<=(p.minStock||0)&&<span style={{color:C.red,fontWeight:700,marginLeft:4}}>(min: {p.minStock})</span>}
</div>
{(p.compatibleWith||[]).length>0&&<div style={{fontSize:11,color:C.dim,marginTop:2}}>Compatible: {p.compatibleWith.map(equipName).join(', ')}</div>}
<div style={{display:'flex',gap:4,marginTop:6}}>
<button onClick={()=>doStockIn(p)} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>+Entree</button>
<button onClick={()=>doStockOut(p)} style={{...btnStyle(C.red),padding:'2px 8px',fontSize:11}}>-Sortie</button>
</div>
{(p.history||[]).length>0&&<div style={{marginTop:6,maxHeight:80,overflow:'auto',fontSize:11}}>
{(p.history||[]).slice(0,5).map((h,i)=><div key={i} style={{color:h.type==='in'?C.green:C.red,padding:'1px 0'}}>{h.type==='in'?'+':'-'}{h.quantity} | {h.date}{h.usedBy?' | '+h.usedBy:''}</div>)}
</div>}
</div>))}
</div>
{showAdd&&sel&&<Mod title={sel.id?'Modifier piece':'Nouvelle piece'} onClose={()=>{setShowAdd(false);setSel(null)}} width={500}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Reference"><input style={inputStyle} value={sel.reference||''} onChange={e=>setSel({...sel,reference:e.target.value})}/></Fl>
<Fl label="Categorie"><select style={inputStyle} value={sel.category} onChange={e=>setSel({...sel,category:e.target.value})}>{PART_CATS.map(c=><option key={c} value={c}>{c}</option>)}</select></Fl>
</div>
<Fl label="Depot"><select style={inputStyle} value={sel.depotId||''} onChange={e=>setSel({...sel,depotId:e.target.value})}><option value="">--</option>{(data.depots||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
<Fl label="Quantite"><input type="number" style={inputStyle} value={sel.quantity} onChange={e=>setSel({...sel,quantity:Number(e.target.value)})}/></Fl>
<Fl label="Prix unitaire"><input type="number" step="0.01" style={inputStyle} value={sel.unitPrice} onChange={e=>setSel({...sel,unitPrice:Number(e.target.value)})}/></Fl>
<Fl label="Stock min"><input type="number" style={inputStyle} value={sel.minStock||1} onChange={e=>setSel({...sel,minStock:Number(e.target.value)})}/></Fl>
</div>
<Fl label="Fournisseur"><input style={inputStyle} value={sel.supplier||''} onChange={e=>setSel({...sel,supplier:e.target.value})}/></Fl>
<Fl label="Compatible avec"><div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{allEquip.map(eq=>{const checked=(sel.compatibleWith||[]).includes(eq.id);return(<label key={eq.id} style={{fontSize:12,display:'flex',gap:3,alignItems:'center',cursor:'pointer'}}><input type="checkbox" checked={checked} onChange={()=>{const cw=[...(sel.compatibleWith||[])];if(checked)setSel({...sel,compatibleWith:cw.filter(x=>x!==eq.id)});else setSel({...sel,compatibleWith:[...cw,eq.id]})}}/>({eq.t}) {eq.name}</label>)})}</div></Fl>
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={doSave} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>{setShowAdd(false);setSel(null)}} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
</div>)};

// ======== INTERVENTIONS ========
const InterventionsPage=({data,save,isAdmin})=>{
const[showAdd,setShowAdd]=useState(false);
const[sel,setSel]=useState(null);
const[filter,setFilter]=useState('');
const[panneTab,setPanneTab]=useState('interventions');
const[showPartPicker,setShowPartPicker]=useState(false);
const[pickerPartId,setPickerPartId]=useState('');
const[pickerQte,setPickerQte]=useState(1);
const allEquip=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'machine'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'camion'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'voiture'}))];
const equipName=id=>{const e=allEquip.find(x=>x.id===id);return e?e.name:'?'};
const interventions=(data.interventions||[]).filter(i=>!filter||(i.machineId===filter||i.truckId===filter||i.carId===filter)).sort((a,b)=>b.date.localeCompare(a.date));
const pannes=(data.panneReports||[]).sort((a,b)=>b.date.localeCompare(a.date));
const blankInter={date:fmtDateISO(new Date()),machineId:'',truckId:'',carId:'',type:'entretien',description:'',employeeId:'',partsUsed:[],laborHours:0,laborCost:0,totalCost:0,status:'done',notes:''};
const openAdd=()=>{setSel({...blankInter});setShowAdd(true)};
const openEdit=i=>{setSel({...i,partsUsed:[...(i.partsUsed||[])]});setShowAdd(true)};
const doSave=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.interventions)nd.interventions=[];const partsCost=(sel.partsUsed||[]).reduce((s,p)=>s+(p.totalPrice||0),0);sel.totalCost=partsCost+(Number(sel.laborCost)||0);const idx=nd.interventions.findIndex(i=>i.id===sel.id);if(idx>=0)nd.interventions[idx]=sel;else{sel.id=uid();nd.interventions.push(sel)}sel.partsUsed.forEach(pu=>{const pp=nd.parts.find(x=>x.id===pu.partId);if(pp){pp.quantity=Math.max(0,(pp.quantity||0)-pu.quantity);if(!pp.history)pp.history=[];pp.history.unshift({type:'out',quantity:pu.quantity,date:sel.date,reason:sel.description});pp.history=pp.history.slice(0,50)}});save(nd);setShowAdd(false);setSel(null)};
const delInter=id=>{if(!confirm('Supprimer ?'))return;save({...data,interventions:(data.interventions||[]).filter(i=>i.id!==id)})};
const updatePanneStatus=(pid,status)=>{const nd=JSON.parse(JSON.stringify(data));const p=(nd.panneReports||[]).find(x=>x.id===pid);if(p){p.status=status;if(status==='resolved')p.resolvedDate=fmtDateISO(new Date());save(nd)}};
const getCompatParts=()=>{const eqId=sel?(sel.machineId||sel.truckId||sel.carId):'';return(data.parts||[]).filter(p=>p.quantity>0&&(!eqId||(p.compatibleWith||[]).length===0||(p.compatibleWith||[]).includes(eqId)))};
const confirmAddPart=()=>{if(!pickerPartId)return;const part=(data.parts||[]).find(p=>p.id===pickerPartId);if(!part)return;const qte=Math.min(pickerQte,part.quantity);if(qte<=0)return;setSel({...sel,partsUsed:[...(sel.partsUsed||[]),{partId:part.id,partName:part.name,quantity:qte,unitPrice:part.unitPrice,totalPrice:qte*part.unitPrice}]});setShowPartPicker(false);setPickerPartId('');setPickerQte(1)};
const removePartFromInter=(idx)=>{if(!sel)return;const pu=[...(sel.partsUsed||[])];pu.splice(idx,1);setSel({...sel,partsUsed:pu})};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
<div style={{display:'flex',gap:6}}>
<button onClick={()=>setPanneTab('interventions')} style={btnStyle(C.accent,panneTab==='interventions')}>Interventions</button>
<button onClick={()=>setPanneTab('pannes')} style={btnStyle(C.orange,panneTab==='pannes')}>Pannes ({pannes.filter(p=>p.status!=='resolved').length})</button>
</div>
<button style={btnStyle(C.accent,true)} onClick={openAdd}>+ Intervention</button>
</div>
{panneTab==='interventions'&&<div>
<select style={{...inputStyle,width:200,marginBottom:12}} value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Tous equipements</option>{allEquip.map(eq=><option key={eq.id} value={eq.id}>({eq.t}) {eq.name}</option>)}</select>
{interventions.map(i=>(
<div key={i.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<div><span style={{fontWeight:700}}>{i.date}</span> <span style={{color:C.dim}}>| {i.type}</span> <span style={{color:C.accent}}>{i.machineId?equipName(i.machineId):i.truckId?equipName(i.truckId):i.carId?equipName(i.carId):'-'}</span></div>
<div style={{display:'flex',gap:4}}><span style={{fontWeight:700,color:C.red}}>{fmtMoney(i.totalCost||0)}</span>{isAdmin&&<button onClick={()=>delInter(i.id)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:14}}>x</button>}<EBtn onClick={()=>openEdit(i)}/></div>
</div>
<div style={{fontSize:13,color:C.dim}}>{i.description}</div>
{(i.partsUsed||[]).length>0&&<div style={{fontSize:12,marginTop:4}}>{i.partsUsed.map((p,pi)=><span key={pi} style={{marginRight:8}}>{p.partName} x{p.quantity} ({fmtMoney(p.totalPrice)})</span>)}</div>}
{i.laborHours>0&&<div style={{fontSize:12,color:C.dim}}>MO: {i.laborHours}h {i.laborCost>0&&'= '+fmtMoney(i.laborCost)}</div>}
</div>))}
</div>}
{panneTab==='pannes'&&<div>
{pannes.map(p=>{const reporter=(data.employees||[]).find(e=>e.id===p.reportedBy);return(
<div key={p.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border,borderLeft:'3px solid '+(p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.muted)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<div><span style={{fontWeight:700}}>{p.date}</span> <Bg text={p.severity} color={p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.dim}/> <Bg text={p.status==='new'?'Nouvelle':p.status==='in_progress'?'En cours':'Resolue'} color={p.status==='resolved'?C.green:p.status==='in_progress'?C.orange:C.red}/></div>
<div style={{display:'flex',gap:4}}>
{p.status==='new'&&<button onClick={()=>updatePanneStatus(p.id,'in_progress')} style={{...btnStyle(C.orange),padding:'2px 8px',fontSize:11}}>Prendre en charge</button>}
{p.status==='in_progress'&&<button onClick={()=>updatePanneStatus(p.id,'resolved')} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>Resolu</button>}
</div></div>
<div style={{fontSize:13}}>{p.machineId?equipName(p.machineId):p.truckId?equipName(p.truckId):p.carId?equipName(p.carId):'-'}</div>
<div style={{fontSize:13,color:C.dim}}>{p.description}</div>
{reporter&&<div style={{fontSize:12,color:C.muted}}>Signale par: {reporter.name}</div>}
</div>)})}
</div>}
{showAdd&&sel&&<Mod title="Intervention" onClose={()=>{setShowAdd(false);setSel(null)}} width={550}>
<Fl label="Date"><input type="date" style={inputStyle} value={sel.date} onChange={e=>setSel({...sel,date:e.target.value})}/></Fl>
<Fl label="Equipement"><select style={inputStyle} value={sel.machineId||sel.truckId||sel.carId||''} onChange={e=>{const v=e.target.value;const eq=allEquip.find(x=>x.id===v);if(!eq)return setSel({...sel,machineId:'',truckId:'',carId:''});if(eq.t==='machine')setSel({...sel,machineId:v,truckId:'',carId:''});else if(eq.t==='camion')setSel({...sel,machineId:'',truckId:v,carId:''});else setSel({...sel,machineId:'',truckId:'',carId:v})}}><option value="">--</option>{allEquip.map(eq=><option key={eq.id} value={eq.id}>({eq.t}) {eq.name}</option>)}</select></Fl>
<Fl label="Type"><select style={inputStyle} value={sel.type} onChange={e=>setSel({...sel,type:e.target.value})}>{INTER_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></Fl>
<Fl label="Description"><textarea style={{...inputStyle,height:60}} value={sel.description} onChange={e=>setSel({...sel,description:e.target.value})}/></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Heures MO"><input type="number" style={inputStyle} value={sel.laborHours||0} onChange={e=>setSel({...sel,laborHours:Number(e.target.value)})}/></Fl>
<Fl label="Cout MO externe"><input type="number" style={inputStyle} value={sel.laborCost||0} onChange={e=>setSel({...sel,laborCost:Number(e.target.value)})}/></Fl>
</div>
<Fl label="Pieces utilisees">
{(sel.partsUsed||[]).map((p,i)=><div key={i} style={{fontSize:12,display:'flex',justifyContent:'space-between',alignItems:'center',padding:'2px 0',borderBottom:'1px solid #f1f5f9'}}><span>{p.partName} x{p.quantity}</span><span style={{display:'flex',gap:6,alignItems:'center'}}><span>{fmtMoney(p.totalPrice)}</span><button onClick={()=>removePartFromInter(i)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:12}}>x</button></span></div>)}
{!showPartPicker&&<button onClick={()=>{setShowPartPicker(true);setPickerPartId('');setPickerQte(1)}} style={{...btnStyle(C.accent),padding:'2px 8px',fontSize:11,marginTop:4}}>+ Piece</button>}
{showPartPicker&&<div style={{background:'#f8fafc',borderRadius:8,padding:8,marginTop:4,border:'1px solid '+C.border}}>
<select style={{...inputStyle,marginBottom:4}} value={pickerPartId} onChange={e=>setPickerPartId(e.target.value)}><option value="">-- Choisir une piece --</option>{getCompatParts().map(p=><option key={p.id} value={p.id}>{p.name} ({p.category}) - stock: {p.quantity} - {fmtMoney(p.unitPrice)}/u</option>)}</select>
<div style={{display:'flex',gap:4,alignItems:'center'}}><input type="number" min="1" max={pickerPartId?(data.parts||[]).find(p=>p.id===pickerPartId)?.quantity||1:1} style={{...inputStyle,width:70}} value={pickerQte} onChange={e=>setPickerQte(Number(e.target.value)||1)} placeholder="Qte"/>
<button onClick={confirmAddPart} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>Ajouter</button>
<button onClick={()=>setShowPartPicker(false)} style={{...btnStyle(C.dim),padding:'2px 8px',fontSize:11}}>Annuler</button></div>
</div>}
</Fl>
<Fl label="Notes"><textarea style={{...inputStyle,height:40}} value={sel.notes||''} onChange={e=>setSel({...sel,notes:e.target.value})}/></Fl>
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={doSave} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>{setShowAdd(false);setSel(null)}} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
</div>)};

// ======== STATS / BREAK-EVEN ========
const StatsPage=({data})=>{
const wdpm=data.workDaysPerMonth||22;
const yearStart=data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1));
const allJobs=(data.jobs||[]).filter(j=>j.date>=yearStart&&j.type!=='depot');
const months=useMemo(()=>{const ms=[];const d=new Date(yearStart);for(let i=0;i<12;i++){const m=new Date(d.getFullYear(),d.getMonth()+i,1);const last=new Date(m.getFullYear(),m.getMonth()+1,0);ms.push({start:fmtDateISO(m),end:fmtDateISO(last),label:m.toLocaleString('fr-FR',{month:'short'})});if(m>new Date())break}return ms},[yearStart]);
const calcMachStats=(mach)=>{let cumCA=0,cumCost=0;const monthData=months.map(mo=>{const mJobs=allJobs.filter(j=>j.machineId===mach.id&&j.date>=mo.start&&j.date<=mo.end);const ca=mJobs.reduce((s,j)=>s+(j.priceForfait||0),0);const fuelCost=mJobs.reduce((s,j)=>{const ft=getMachineFuelType(data,mach.id);const fp=getFuelPrice(data,ft,j.machineFuelDepot);return s+(j.machineFuelL||0)*fp},0);const assJour=(mach.insuranceMonthly||0)/wdpm;const credJour=(Number(mach.creditMonthly)||0)/wdpm;const ctJour=((mach.ctCost||0)/12)/wdpm;const daysUsed=[...new Set(mJobs.map(j=>j.date))].length;const fixedCost=(assJour+credJour+ctJour)*daysUsed;const interCost=(data.interventions||[]).filter(i=>i.machineId===mach.id&&i.date>=mo.start&&i.date<=mo.end).reduce((s,i)=>s+(i.totalCost||0),0);const cost=fuelCost+fixedCost+interCost;cumCA+=ca;cumCost+=cost;return{label:mo.label,ca,cost,cumCA,cumCost}});return{monthData,totalCA:cumCA,totalCost:cumCost,result:cumCA-cumCost}};
const maxH=200;
return(
<div>
<h2 style={{marginBottom:16}}>Statistiques et Point mort</h2>
<h3 style={{marginBottom:8,color:C.accent}}>Machines</h3>
{(data.machines||[]).map(mach=>{const stats=calcMachStats(mach);const maxVal=Math.max(...stats.monthData.map(m=>Math.max(m.cumCA,m.cumCost)),1);const breakMonth=stats.monthData.find(m=>m.cumCA>=m.cumCost&&m.cumCA>0);return(
<div key={mach.id} style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
<strong style={{color:MC[mach.type]||C.accent,fontSize:16}}>{mach.name}</strong>
<span style={{fontWeight:700,color:stats.result>=0?C.green:C.red,fontSize:15}}>{stats.result>=0?'+':''}{fmtMoney(stats.result)}</span>
</div>
<div style={{display:'flex',gap:16,marginBottom:12,fontSize:13}}>
<span>CA cumule: <b style={{color:C.green}}>{fmtMoney(stats.totalCA)}</b></span>
<span>Couts cumules: <b style={{color:C.red}}>{fmtMoney(stats.totalCost)}</b></span>
{breakMonth&&<span>Point mort: <b style={{color:C.accent}}>{breakMonth.label}</b></span>}
</div>
<div style={{display:'flex',alignItems:'flex-end',gap:2,height:maxH,marginBottom:8,background:'#f8fafc',borderRadius:8,padding:'8px 4px'}}>
{stats.monthData.map((m,i)=>{const hCA=(m.cumCA/maxVal)*maxH*0.9;const hCost=(m.cumCost/maxVal)*maxH*0.9;return(
<div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
<div style={{width:'100%',display:'flex',justifyContent:'center',gap:1,alignItems:'flex-end',height:maxH*0.9}}>
<div style={{width:'40%',height:Math.max(hCA,2),background:C.green,borderRadius:2,opacity:.7}}/>
<div style={{width:'40%',height:Math.max(hCost,2),background:C.red,borderRadius:2,opacity:.7}}/>
</div>
<div style={{fontSize:9,color:C.dim}}>{m.label}</div>
</div>)})}
</div>
<div style={{display:'flex',gap:12,fontSize:11,color:C.dim}}><span style={{display:'flex',alignItems:'center',gap:3}}><span style={{width:10,height:10,background:C.green,borderRadius:2,display:'inline-block'}}/> CA cumule</span><span style={{display:'flex',alignItems:'center',gap:3}}><span style={{width:10,height:10,background:C.red,borderRadius:2,display:'inline-block'}}/> Couts cumules</span></div>
</div>)})}
<h3 style={{marginBottom:8,marginTop:24,color:C.cyan}}>Camions</h3>
{(data.trucks||[]).map(truck=>{const truckJobs=allJobs.filter(j=>{const emp=(data.employees||[]).find(e=>e.id===j.employeeId);return emp&&emp.truckId===truck.id});const totalRevTransf=truckJobs.reduce((s,j)=>s+(j.hasTransfer?j.transferPrice||0:0),0);const totalFuelCost=truckJobs.reduce((s,j)=>{const ft=getMachineFuelType(data,j.machineId);const fp=getFuelPrice(data,'gazole',j.startFrom!=='home'?j.startFrom:null);const truckC=Number(truck.fuelPer100)||25;return s+((j.distanceKm||0)/100)*truckC*fp},0);const interCost=(data.interventions||[]).filter(i=>i.truckId===truck.id&&i.date>=yearStart).reduce((s,i)=>s+(i.totalCost||0),0);const fixedCost=((truck.insuranceMonthly||0)+(Number(truck.creditMonthly)||0)+((truck.ctCost||0)/12))*((new Date()-new Date(yearStart))/(30*86400000));const totalCost=totalFuelCost+interCost+fixedCost;const result=totalRevTransf-totalCost;return(
<div key={truck.id} style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:10}}>
<div style={{display:'flex',justifyContent:'space-between'}}><strong>{truck.name}</strong><span style={{fontWeight:700,color:result>=0?C.green:C.red}}>{result>=0?'+':''}{fmtMoney(result)}</span></div>
<div style={{fontSize:13,color:C.dim}}>Transferts: {fmtMoney(totalRevTransf)} | Carbu: {fmtMoney(totalFuelCost)} | Interventions: {fmtMoney(interCost)} | Fixes: {fmtMoney(fixedCost)}</div>
</div>)})}
</div>)};

// ======== MECHANIC VIEW ========
const MechanicView=({data,save,empId,onLogout})=>{
const emp=(data.employees||[]).find(e=>e.id===empId);
const[pg,setPg]=useState('stock');
if(!emp)return(<div>Employe non trouve</div>);
return(
<div style={{maxWidth:900,margin:'0 auto',padding:16}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,background:'#475569',color:'#fff',padding:'12px 16px',borderRadius:10}}>
<div style={{display:'flex',alignItems:'center',gap:10}}>
<div style={{width:40,height:40,borderRadius:'50%',background:'#fff3',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:18}}>{(emp.name||'?')[0].toUpperCase()}</div>
<div><div style={{fontWeight:700,fontSize:18}}>{emp.name}</div><div style={{fontSize:14,opacity:.8}}>Espace mecanicien</div></div>
</div>
<div style={{display:'flex',gap:6}}><button onClick={()=>{loadData().then(d2=>{if(d2){save(d2);alert('Actualisé !')}})}} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>↻</button><button onClick={onLogout} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>Deconnexion</button></div>
</div>
<div style={{display:'flex',gap:6,marginBottom:16}}>
<button onClick={()=>setPg('stock')} style={btnStyle('#475569',pg==='stock')}>Stock pieces</button>
<button onClick={()=>setPg('interventions')} style={btnStyle('#475569',pg==='interventions')}>Interventions</button>
<button onClick={()=>setPg('pannes')} style={btnStyle(C.orange,pg==='pannes')}>Pannes ({(data.panneReports||[]).filter(p=>p.status!=='resolved').length})</button>
</div>
{pg==='stock'&&<StockPage data={data} save={save} isAdmin={false}/>}
{pg==='interventions'&&<InterventionsPage data={data} save={save} isAdmin={false}/>}
{pg==='pannes'&&(()=>{const allEquip=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'machine'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'camion'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'voiture'}))];const equipName=id=>{const e=allEquip.find(x=>x.id===id);return e?e.name:'?'};const pannes=(data.panneReports||[]).sort((a,b)=>b.date.localeCompare(a.date));const updatePanneStatus=(pid,status)=>{const nd=JSON.parse(JSON.stringify(data));const p=(nd.panneReports||[]).find(x=>x.id===pid);if(p){p.status=status;if(status==='resolved')p.resolvedDate=fmtDateISO(new Date());save(nd)}};return(<div>{pannes.map(p=>{const reporter=(data.employees||[]).find(e=>e.id===p.reportedBy);return(<div key={p.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border,borderLeft:'3px solid '+(p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.muted)}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}><div><span style={{fontWeight:700}}>{p.date}</span> <Bg text={p.severity} color={p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.dim}/> <Bg text={p.status==='new'?'Nouvelle':p.status==='in_progress'?'En cours':'Resolue'} color={p.status==='resolved'?C.green:p.status==='in_progress'?C.orange:C.red}/></div><div style={{display:'flex',gap:4}}>{p.status==='new'&&<button onClick={()=>updatePanneStatus(p.id,'in_progress')} style={{...btnStyle(C.orange),padding:'2px 8px',fontSize:11}}>Prendre en charge</button>}{p.status==='in_progress'&&<button onClick={()=>updatePanneStatus(p.id,'resolved')} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>Resolu</button>}</div></div><div style={{fontSize:13}}>{p.machineId?equipName(p.machineId):p.truckId?equipName(p.truckId):p.carId?equipName(p.carId):'-'}</div><div style={{fontSize:13,color:C.dim}}>{p.description}</div>{reporter&&<div style={{fontSize:12,color:C.muted}}>Signale par: {reporter.name}</div>}</div>)})}{pannes.length===0&&<div style={{color:C.dim,fontSize:14,padding:20,textAlign:'center'}}>Aucune panne signalee</div>}</div>)})()}
</div>)};

// ======== HEURES PAGE ========
const getISOWeek=(d)=>{const dt=new Date(d);dt.setHours(0,0,0,0);dt.setDate(dt.getDate()+3-(dt.getDay()+6)%7);const w1=new Date(dt.getFullYear(),0,4);return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7)};
const frDay=(d)=>{const dt=new Date(d);const jours=['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];const mois=['janv.','fevr.','mars','avr.','mai','juin','juil.','aout','sept.','oct.','nov.','dec.'];return jours[dt.getDay()]+' '+dt.getDate()+' '+mois[dt.getMonth()]};
const toDecHours=(startTime,endTime,pauseMin)=>{if(!startTime||!endTime)return 0;const[sh,sm]=(startTime||'0:0').split(':').map(Number);const[eh,em]=(endTime||'0:0').split(':').map(Number);const mins=(eh*60+em)-(sh*60+sm)-(pauseMin||0);return Math.round(Math.max(0,mins/60)*100)/100};
const calcSupp=(totalSemaine,seuil25,seuil50)=>{const h25=Math.max(0,Math.min(totalSemaine,seuil50)-seuil25);const h50=Math.max(0,totalSemaine-seuil50);return{h25,h50}};
const fmtDec=(n)=>n.toFixed(2).replace('.',',');
const HeuresPage=({data,save})=>{
const emps=data.employees||[];
const[selEmp,setSelEmp]=useState(emps[0]?.id||'');
const now=new Date();const mStart=now.getFullYear()+'-'+pad2(now.getMonth()+1)+'-01';const mEnd=fmtDateISO(new Date(now.getFullYear(),now.getMonth()+1,0));
const[dateStart,setDateStart]=useState(mStart);
const[dateEnd,setDateEnd]=useState(mEnd);
const seuil25=data.overtime25Threshold||35;const seuil50=data.overtime50Threshold||43;const refH=data.refHoursPerDay||1;
const empName=(emps.find(e=>e.id===selEmp)||{}).name||'';
// Get all dates in range
const allDates=useMemo(()=>{const dates=[];const d=new Date(dateStart);const end=new Date(dateEnd);while(d<=end){dates.push(fmtDateISO(d));d.setDate(d.getDate()+1)}return dates},[dateStart,dateEnd]);
// TimeEntries for this employee in range
const entries=useMemo(()=>(data.timeEntries||[]).filter(t=>t.empId===selEmp&&t.date>=dateStart&&t.date<=dateEnd).sort((a,b)=>a.date.localeCompare(b.date)),[data.timeEntries,selEmp,dateStart,dateEnd]);
// Validated entries
const validated=useMemo(()=>(data.timeEntriesValidated||[]).filter(t=>t.empId===selEmp&&t.date>=dateStart&&t.date<=dateEnd).sort((a,b)=>a.date.localeCompare(b.date)),[data.timeEntriesValidated,selEmp,dateStart,dateEnd]);
// Build rows per date for declared
const declaredRows=useMemo(()=>{return allDates.map(date=>{const te=entries.find(t=>t.date===date);if(!te)return{date,week:getISOWeek(date),empty:true};const pauseMin=te.pauseMin||0;const worked=toDecHours(te.startTime,te.endTime,pauseMin);const brS=te.breakStart||te.pauseStart||'';const brE=te.breakEnd||te.pauseEnd||'';const createdAt=te.createdAt?new Date(te.createdAt):null;const horodateur=createdAt?pad2(createdAt.getDate())+'/'+pad2(createdAt.getMonth()+1)+' '+pad2(createdAt.getHours())+'h':'';return{date,week:getISOWeek(date),horodateur,absence:te.absenceType||'',start:te.startTime||'',breakStart:brS,meal:te.mealType||'',breakEnd:brE,end:te.endTime||'',worked,night:te.nightHours||0,ref:refH,empty:false,id:te.id}})},[allDates,entries,refH]);
// Build rows per date for validated
const validatedRows=useMemo(()=>{return allDates.map(date=>{const te=validated.find(t=>t.date===date);const orig=entries.find(t=>t.date===date);if(!te&&!orig)return{date,week:getISOWeek(date),empty:true};if(!te&&orig){const pauseMin=orig.pauseMin||0;const worked=toDecHours(orig.startTime,orig.endTime,pauseMin);return{date,week:getISOWeek(date),start:orig.startTime||'',breakStart:orig.breakStart||orig.pauseStart||'',meal:orig.mealType||'PANIER',breakEnd:orig.breakEnd||orig.pauseEnd||'',end:orig.endTime||'',absence:orig.absenceType||'',night:orig.nightHours||0,ref:refH,worked,empty:false,fromDeclared:true}}const pauseMin2=te.breakStart&&te.breakEnd?((h,m)=>{const[sh2,sm2]=te.breakStart.split(':').map(Number);const[eh2,em2]=te.breakEnd.split(':').map(Number);return(eh2*60+em2)-(sh2*60+sm2)})(0,0):0;const worked2=toDecHours(te.startTime,te.endTime,pauseMin2);return{date,week:getISOWeek(date),start:te.startTime||'',breakStart:te.breakStart||'',meal:te.mealType||'',breakEnd:te.breakEnd||'',end:te.endTime||'',absence:te.absenceType||'',night:te.nightHours||0,ref:te.refHours!=null?te.refHours:refH,worked:worked2,empty:false,fromDeclared:false,id:te.id}})},[allDates,validated,entries,refH]);
// Group by week for totals
const weekTotals=(rows)=>{const wk={};rows.forEach(r=>{if(!wk[r.week])wk[r.week]={total:0,night:0};if(!r.empty&&!r.absence)wk[r.week].total+=r.worked;wk[r.week].night+=(r.night||0)});const result={};Object.keys(wk).forEach(w=>{const{h25,h50}=calcSupp(wk[w].total,seuil25,seuil50);result[w]={total:wk[w].total,h25,h50,night:wk[w].night}});return result};
const declWeeks=useMemo(()=>weekTotals(declaredRows),[declaredRows,seuil25,seuil50]);
const valWeeks=useMemo(()=>weekTotals(validatedRows),[validatedRows,seuil25,seuil50]);
// Period totals
const periodTotals=(wks)=>{let t=0,h25=0,h50=0,night=0;Object.values(wks).forEach(w=>{t+=w.total;h25+=w.h25;h50+=w.h50;night+=w.night});return{t,h25,h50,night}};
const declTot=periodTotals(declWeeks);const valTot=periodTotals(valWeeks);
// Update validated entry
const updateVal=(date,field,value)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntriesValidated)nd.timeEntriesValidated=[];let idx=nd.timeEntriesValidated.findIndex(t=>t.empId===selEmp&&t.date===date);if(idx<0){const orig=(nd.timeEntries||[]).find(t=>t.empId===selEmp&&t.date===date);const base=orig?{startTime:orig.startTime||'',breakStart:orig.breakStart||orig.pauseStart||'',mealType:orig.mealType||'PANIER',breakEnd:orig.breakEnd||orig.pauseEnd||'',endTime:orig.endTime||'',absenceType:orig.absenceType||'',nightHours:orig.nightHours||0,refHours:refH}:{startTime:'',breakStart:'12:00',mealType:'PANIER',breakEnd:'13:00',endTime:'',absenceType:'',nightHours:0,refHours:refH};nd.timeEntriesValidated.push({id:uid(),empId:selEmp,date,...base});idx=nd.timeEntriesValidated.length-1}nd.timeEntriesValidated[idx][field]=value;save(nd)};
// Copy from declared
const copyFromDeclared=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntriesValidated)nd.timeEntriesValidated=[];nd.timeEntriesValidated=nd.timeEntriesValidated.filter(t=>!(t.empId===selEmp&&t.date>=dateStart&&t.date<=dateEnd));entries.forEach(te=>{nd.timeEntriesValidated.push({id:uid(),empId:selEmp,date:te.date,startTime:te.startTime||'',breakStart:te.breakStart||te.pauseStart||'',mealType:te.mealType||'PANIER',breakEnd:te.breakEnd||te.pauseEnd||'',endTime:te.endTime||'',absenceType:te.absenceType||'',nightHours:te.nightHours||0,refHours:refH})});save(nd);alert('Heures copiees depuis declare !')};
// CSV export per table
const doExportCSV=(type)=>{const rows2=(type==='declared'?declaredRows:validatedRows).filter(r=>!r.empty);const label=type==='declared'?'declarees':'validees';let csv='Semaine;Date;Absence;Debut;Coupure;Repas;Reprise;Debauche;Travail;Ref;Nuit\n';rows2.forEach(r=>{csv+=r.week+';'+frDay(r.date)+';'+(r.absence||'')+';'+r.start+';'+r.breakStart+';'+r.meal+';'+r.breakEnd+';'+r.end+';'+fmtDec(r.worked)+';'+fmtDec(r.ref||0)+';'+fmtDec(r.night||0)+'\n'});const wks=type==='declared'?declWeeks:valWeeks;Object.keys(wks).forEach(w=>{const wk=wks[w];csv+='\nSemaine '+w+';'+fmtDec(wk.total)+';25%: '+fmtDec(wk.h25)+';50%: '+fmtDec(wk.h50)+';Nuit: '+fmtDec(wk.night)+'\n'});const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='soneco_heures_'+label+'_'+empName.replace(/\s/g,'_')+'_'+dateStart+'.csv';a.click();URL.revokeObjectURL(url)};
// Mail per table
const doMail=(type)=>{const rows2=(type==='declared'?declaredRows:validatedRows).filter(r=>!r.empty);const tots=type==='declared'?declTot:valTot;const wks=type==='declared'?declWeeks:valWeeks;const label=type==='declared'?'Heures declarees':'Heures validees';const subject='SONECO - '+label+' '+empName+' - '+dateStart+' au '+dateEnd;let body='SONECO - '+label+'\n';body+='Salarie : '+empName+'\n';body+='Periode : '+dateStart+' au '+dateEnd+'\n\n';body+='Totale: '+fmtDec(tots.t)+'h | 25%: '+fmtDec(tots.h25)+'h | 50%: '+fmtDec(tots.h50)+'h | Nuit: '+fmtDec(tots.night)+'h\n\n';body+='DATE                  DEBUT  COUPURE  REPAS    REPRISE  DEBAUCHE  TRAVAIL  NUIT\n';body+='------------------------------------------------------------------------\n';let lastW2=null;rows2.forEach(r=>{if(lastW2!==null&&r.week!==lastW2&&wks[lastW2]){const w=wks[lastW2];body+='\nSemaine '+lastW2+': '+fmtDec(w.total)+'h | 25%: '+fmtDec(w.h25)+'h | 50%: '+fmtDec(w.h50)+'h | Nuit: '+fmtDec(w.night)+'h\n\n'}lastW2=r.week;const pad=(s,n)=>(s||'').padEnd(n);body+=pad(frDay(r.date),22)+pad(r.start,7)+pad(r.breakStart,9)+pad(r.meal,9)+pad(r.breakEnd,9)+pad(r.end,10)+pad(fmtDec(r.worked),9)+fmtDec(r.night||0)+'\n'});if(lastW2!==null&&wks[lastW2]){const w=wks[lastW2];body+='\nSemaine '+lastW2+': '+fmtDec(w.total)+'h | 25%: '+fmtDec(w.h25)+'h | 50%: '+fmtDec(w.h50)+'h | Nuit: '+fmtDec(w.night)+'h\n'}window.open('mailto:?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body))};
// Print per table
const doPrint=(type)=>{const rows2=(type==='declared'?declaredRows:validatedRows).filter(r=>!r.empty);const tots=type==='declared'?declTot:valTot;const wks=type==='declared'?declWeeks:valWeeks;const label=type==='declared'?'Heures declarees':'Heures validees';let tbodyHtml='';let lastW3=null;rows2.forEach(r=>{if(lastW3!==null&&r.week!==lastW3&&wks[lastW3]){const w=wks[lastW3];tbodyHtml+='<tr class="week"><td colspan="11">Semaine '+lastW3+' : '+fmtDec(w.total)+'h &nbsp; 25%: '+fmtDec(w.h25)+'h &nbsp; 50%: '+fmtDec(w.h50)+'h &nbsp; Nuit: '+fmtDec(w.night)+'h</td></tr>'}lastW3=r.week;tbodyHtml+='<tr><td>'+r.week+'</td><td>'+frDay(r.date)+'</td><td>'+(r.absence||'')+'</td><td>'+r.start+'</td><td>'+r.breakStart+'</td><td>'+(r.meal||'')+'</td><td>'+r.breakEnd+'</td><td>'+r.end+'</td><td><b>'+fmtDec(r.worked)+'</b></td><td>'+fmtDec(r.ref||0)+'</td><td>'+fmtDec(r.night||0)+'</td></tr>'});if(lastW3!==null&&wks[lastW3]){const w=wks[lastW3];tbodyHtml+='<tr class="week"><td colspan="11">Semaine '+lastW3+' : '+fmtDec(w.total)+'h &nbsp; 25%: '+fmtDec(w.h25)+'h &nbsp; 50%: '+fmtDec(w.h50)+'h &nbsp; Nuit: '+fmtDec(w.night)+'h</td></tr>'}const html='<!DOCTYPE html><html><head><title>SONECO - '+label+' '+empName+'</title><style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px}h1{font-size:16px;color:#008965;margin:0}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f1f5f9;padding:5px 4px;text-align:left;font-size:10px;border:1px solid #e2e8f0}td{padding:4px;border:1px solid #e2e8f0}.week{background:#f8fafc;font-weight:bold;text-align:right}.totals{font-size:13px;font-weight:bold;text-align:right;margin:10px 0}@media print{body{margin:10px}}</style></head><body><div style="display:flex;justify-content:space-between"><div><h1>SONECO</h1><p><strong>'+empName+'</strong></p><p>'+label+'</p></div><div style="text-align:right"><p>Du '+dateStart+'</p><p>Au '+dateEnd+'</p></div></div><div class="totals">Totale: '+fmtDec(tots.t)+'h &nbsp; 25%: '+fmtDec(tots.h25)+'h &nbsp; 50%: '+fmtDec(tots.h50)+'h &nbsp; Nuit: '+fmtDec(tots.night)+'h</div><table><thead><tr><th>Sem.</th><th>Date</th><th>Absence</th><th>Debut</th><th>Coupure</th><th>Repas</th><th>Reprise</th><th>Debauche</th><th>Travail</th><th>Ref</th><th>Nuit</th></tr></thead><tbody>'+tbodyHtml+'</tbody></table></body></html>';const w2=window.open('','_blank');w2.document.write(html);w2.document.close();w2.print()};
// Table styles
const thS={fontSize:10,fontWeight:700,padding:'4px 3px',borderBottom:'2px solid '+C.border,background:'#f1f5f9',textAlign:'center',whiteSpace:'nowrap'};
const tdS={fontSize:11,padding:'3px 2px',borderBottom:'1px solid #f1f5f9',textAlign:'center',whiteSpace:'nowrap'};
const weekRowS={fontSize:11,fontWeight:700,padding:'4px 6px',background:'#e2e8f0',textAlign:'right'};
const inpTimeS={border:'1px solid #e2e8f0',background:'#f8fafc',borderRadius:4,fontSize:12,width:75,textAlign:'center',padding:'3px 4px'};
const inpSelS={border:'1px solid #e2e8f0',background:'#f8fafc',borderRadius:4,fontSize:11,width:68,textAlign:'center',padding:'3px 2px'};
const inpNumS={border:'1px solid #e2e8f0',background:'#f8fafc',borderRadius:4,fontSize:12,width:50,textAlign:'center',padding:'3px 4px'};
const smallBtnS={padding:'3px 8px',fontSize:11,borderRadius:4,cursor:'pointer',border:'1px solid '+C.border,background:'#f8fafc',color:C.dim,fontWeight:500,whiteSpace:'nowrap'};
// Render table
const renderTable=(rows,weeks,totals,editable)=>{let lastWeek=null;const trs=[];rows.forEach((r,i)=>{const isEven=i%2===0;const bg=isEven?'#fafbfc':'#fff';
if(lastWeek!==null&&r.week!==lastWeek&&weeks[lastWeek]){const w=weeks[lastWeek];trs.push(<tr key={'w'+lastWeek}><td colSpan={11} style={weekRowS}>Semaine {lastWeek} : <span style={{color:C.accent}}>{fmtDec(w.total)}</span> <span style={{color:C.orange,marginLeft:8}}>25%: {fmtDec(w.h25)}</span> <span style={{color:C.red,marginLeft:8}}>50%: {fmtDec(w.h50)}</span> <span style={{color:C.purple,marginLeft:8}}>Nuit: {fmtDec(w.night)}</span></td></tr>)}lastWeek=r.week;
if(r.empty){trs.push(<tr key={r.date} style={{background:bg}}><td style={tdS}></td><td style={tdS}>{r.week}</td><td style={{...tdS,textAlign:'left',fontSize:10}}>{frDay(r.date)}</td><td colSpan={8} style={{...tdS,color:C.muted,fontStyle:'italic'}}>—</td></tr>);return}
const origRow=editable?declaredRows.find(d=>d.date===r.date):null;
const isDiff=(field)=>editable&&origRow&&!origRow.empty&&origRow[field]!==r[field];
const cellBg=(field)=>isDiff(field)?'#fff7ed':'transparent';
if(!editable){trs.push(<tr key={r.date} style={{background:bg}}><td style={tdS}>{r.horodateur||''}</td><td style={tdS}>{r.week}</td><td style={{...tdS,textAlign:'left',fontSize:10}}>{frDay(r.date)}</td><td style={{...tdS,color:r.absence?C.red:C.dim}}>{r.absence||''}</td><td style={tdS}>{r.start}</td><td style={tdS}>{r.breakStart}</td><td style={{...tdS,fontWeight:600,color:r.meal==='PANIER'?C.accent:C.orange}}>{r.meal}</td><td style={tdS}>{r.breakEnd}</td><td style={tdS}>{r.end}</td><td style={{...tdS,fontWeight:600}}>{fmtDec(r.worked)}</td><td style={tdS}>{fmtDec(r.ref||0)} <span style={{color:C.purple}}>{fmtDec(r.night||0)}</span></td></tr>)}else{
trs.push(<tr key={r.date} style={{background:bg}}><td style={tdS}></td><td style={tdS}>{r.week}</td><td style={{...tdS,textAlign:'left',fontSize:10}}>{frDay(r.date)}</td><td style={{...tdS,background:cellBg('absence')}}><select value={r.absence||''} onChange={e=>updateVal(r.date,'absenceType',e.target.value)} style={{...inpSelS,background:cellBg('absence')||'#f8fafc'}}><option value=""></option><option value="maladie">Maladie</option><option value="conge">Conge</option><option value="rtt">RTT</option><option value="autre">Autre</option></select></td><td style={{...tdS,background:cellBg('start')}}><input type="time" value={r.start} onChange={e=>updateVal(r.date,'startTime',e.target.value)} style={{...inpTimeS,background:cellBg('start')||'#f8fafc'}}/></td><td style={{...tdS,background:cellBg('breakStart')}}><input type="time" value={r.breakStart} onChange={e=>updateVal(r.date,'breakStart',e.target.value)} style={{...inpTimeS,background:cellBg('breakStart')||'#f8fafc'}}/></td><td style={{...tdS,background:cellBg('meal')}}><select value={r.meal} onChange={e=>updateVal(r.date,'mealType',e.target.value)} style={{...inpSelS,background:cellBg('meal')||'#f8fafc',fontWeight:600,color:r.meal==='PANIER'?C.accent:C.orange}}><option value="PANIER">PANIER</option><option value="RESTO">RESTO</option></select></td><td style={{...tdS,background:cellBg('breakEnd')}}><input type="time" value={r.breakEnd} onChange={e=>updateVal(r.date,'breakEnd',e.target.value)} style={{...inpTimeS,background:cellBg('breakEnd')||'#f8fafc'}}/></td><td style={{...tdS,background:cellBg('end')}}><input type="time" value={r.end} onChange={e=>updateVal(r.date,'endTime',e.target.value)} style={{...inpTimeS,background:cellBg('end')||'#f8fafc'}}/></td><td style={{...tdS,fontWeight:600}}>{fmtDec(r.worked)}</td><td style={{...tdS,background:cellBg('night')}}><input type="number" step="0.25" value={r.night} onChange={e=>updateVal(r.date,'nightHours',Number(e.target.value)||0)} style={{...inpNumS,background:cellBg('night')||'#f8fafc'}}/></td></tr>)}});
if(lastWeek!==null&&weeks[lastWeek]){const w=weeks[lastWeek];trs.push(<tr key={'w'+lastWeek}><td colSpan={11} style={weekRowS}>Semaine {lastWeek} : <span style={{color:C.accent}}>{fmtDec(w.total)}</span> <span style={{color:C.orange,marginLeft:8}}>25%: {fmtDec(w.h25)}</span> <span style={{color:C.red,marginLeft:8}}>50%: {fmtDec(w.h50)}</span> <span style={{color:C.purple,marginLeft:8}}>Nuit: {fmtDec(w.night)}</span></td></tr>)}
return(<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}><thead><tr><th style={thS}>Horodateur</th><th style={thS}>Sem.</th><th style={{...thS,textAlign:'left'}}>DATE</th><th style={thS}>ABSENCE</th><th style={thS}>DEBUT</th><th style={thS}>COUPURE</th><th style={thS}>REPAS</th><th style={thS}>REPRISE</th><th style={thS}>DEBAUCHE</th><th style={thS}>Tps tr.</th><th style={thS}>Ref/Nuit</th></tr></thead><tbody>{trs}</tbody></table>)};
return(
<div>
<h2 style={{marginBottom:16}}>Heures</h2>
<div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
<Fl label="Salarie"><select style={{...inputStyle,width:180}} value={selEmp} onChange={e=>setSelEmp(e.target.value)}>{emps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Fl>
<Fl label="Debut"><input type="date" style={{...inputStyle,width:150}} value={dateStart} onChange={e=>setDateStart(e.target.value)}/></Fl>
<Fl label="Fin"><input type="date" style={{...inputStyle,width:150}} value={dateEnd} onChange={e=>setDateEnd(e.target.value)}/></Fl>
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:20,overflow:'auto'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4,flexWrap:'wrap',gap:6}}>
<h3 style={{margin:0,fontSize:15}}>&#128274; Heures declarees par {empName}</h3>
<div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
<div style={{fontSize:12,display:'flex',gap:10,marginRight:8}}>
<span>totale <b style={{color:C.accent}}>{fmtDec(declTot.t)}</b></span>
<span>25% <b style={{color:C.orange}}>{fmtDec(declTot.h25)}</b></span>
<span>50% <b style={{color:C.red}}>{fmtDec(declTot.h50)}</b></span>
<span>Nuit <b style={{color:C.purple}}>{fmtDec(declTot.night)}</b></span>
</div>
<button onClick={()=>doMail('declared')} style={smallBtnS}>&#128231; Mail</button>
<button onClick={()=>doPrint('declared')} style={smallBtnS}>&#128424; Imprimer</button>
<button onClick={()=>doExportCSV('declared')} style={smallBtnS}>&#128229; CSV</button>
</div>
</div>
{renderTable(declaredRows,declWeeks,declTot,false)}
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,overflow:'auto'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4,flexWrap:'wrap',gap:6}}>
<h3 style={{margin:0,fontSize:15}}>&#9998; Heures validees — {empName}</h3>
<div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
<div style={{fontSize:12,display:'flex',gap:10,marginRight:8}}>
<span>totale <b style={{color:C.accent}}>{fmtDec(valTot.t)}</b></span>
<span>25% <b style={{color:C.orange}}>{fmtDec(valTot.h25)}</b></span>
<span>50% <b style={{color:C.red}}>{fmtDec(valTot.h50)}</b></span>
<span>Nuit <b style={{color:C.purple}}>{fmtDec(valTot.night)}</b></span>
</div>
<button onClick={copyFromDeclared} style={{...smallBtnS,background:'#f0fdfa',color:C.cyan,borderColor:C.cyan}}>Copier depuis declare</button>
<button onClick={()=>doMail('validated')} style={smallBtnS}>&#128231; Mail</button>
<button onClick={()=>doPrint('validated')} style={smallBtnS}>&#128424; Imprimer</button>
<button onClick={()=>doExportCSV('validated')} style={smallBtnS}>&#128229; CSV</button>
</div>
</div>
{renderTable(validatedRows,valWeeks,valTot,true)}
</div>
</div>)};

// ======== ADMIN PANEL ========
const AdminPanel=({data,save,onLogout,onUndo})=>{
const[pg,setPg]=useState('planning');const[mobOpen,setMobOpen]=useState(false);
const pages=[{k:'planning',l:'Planning',i:'&#128197;'},{k:'dashboard',l:'Dashboard',i:'&#128200;'},{k:'depots',l:'Depots',i:'&#127981;'},{k:'machines',l:'Machines',i:'&#9881;'},{k:'trucks',l:'Camions',i:'&#128666;'},{k:'cars',l:'Voitures',i:'&#128663;'},{k:'employees',l:'Employes',i:'&#128100;'},{k:'clients',l:'Clients',i:'&#128188;'},{k:'forfaits',l:'Forfaits',i:'&#128176;'},{k:'heures',l:'Heures',i:'&#128337;'},{k:'stock',l:'Stock',i:'&#128230;'},{k:'interventions',l:'Interventions',i:'&#128295;'},{k:'stats',l:'Stats',i:'&#128202;'},{k:'settings',l:'Parametres',i:'&#9881;'}];
const content=()=>{switch(pg){case'planning':return(<PlanningPage data={data} save={save}/>);case'dashboard':return(<DashboardPage data={data}/>);case'depots':return(<DepotsPage data={data} save={save}/>);case'machines':return(<MachinesPage data={data} save={save}/>);case'trucks':return(<TrucksPage data={data} save={save}/>);case'cars':return(<CarsPage data={data} save={save}/>);case'employees':return(<EmployeesPage data={data} save={save}/>);case'clients':return(<ClientsPage data={data} save={save}/>);case'forfaits':return(<ForfaitsPage data={data} save={save}/>);case'heures':return(<HeuresPage data={data} save={save}/>);case'stock':return(<StockPage data={data} save={save} isAdmin={true}/>);case'interventions':return(<InterventionsPage data={data} save={save} isAdmin={true}/>);case'stats':return(<StatsPage data={data}/>);case'settings':return(<SettingsPage data={data} save={save}/>);default:return null}};
return(
<div>
{mobOpen&&<div className="sb-overlay" style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.3)',zIndex:199}} onClick={()=>setMobOpen(false)}/>}
<button className="mob-btn" onClick={()=>setMobOpen(!mobOpen)} style={{position:'fixed',top:8,left:8,zIndex:300,background:C.accent,color:'#fff',border:'none',borderRadius:6,width:36,height:36,cursor:'pointer',fontSize:20,display:'none'}}>&#9776;</button>
<div className={'sb'+(mobOpen?' open':'')} style={{position:'fixed',top:0,left:0,width:160,height:'100vh',background:'#1e293b',padding:'16px 0',zIndex:200,overflowY:'auto'}}>
<div style={{padding:'8px 12px',marginBottom:8}}><img src="logo.png" alt="SONECO" style={{width:120,marginBottom:2}}/><div style={{fontSize:9,color:'#94a3b8',marginTop:2}}>RoadManager</div></div>
{pages.map(p=>(
<div key={p.k} onClick={()=>{setPg(p.k);setMobOpen(false)}} style={{padding:'8px 12px',cursor:'pointer',color:pg===p.k?'#fff':'#94a3b8',background:pg===p.k?'#334155':'transparent',fontSize:13,fontWeight:pg===p.k?700:400,display:'flex',alignItems:'center',gap:8}}>
<span dangerouslySetInnerHTML={{__html:p.i}}/>{p.l}
</div>))}
<div onClick={onUndo} style={{padding:'8px 12px',cursor:'pointer',color:'#fbbf24',fontSize:13,marginTop:16,borderTop:'1px solid #334155'}}>↩ Annuler</div>
<div onClick={onLogout} style={{padding:'8px 12px',cursor:'pointer',color:'#f87171',fontSize:13}}>Deconnexion</div>
</div>
<div className="main" style={{marginLeft:160,padding:20,minHeight:'100vh',background:C.bg}}>
{content()}
</div></div>)};

// ======== APP ROOT ========
const App=()=>{
const savedSession=(()=>{try{const s=localStorage.getItem('rm-session');return s?JSON.parse(s):null}catch(e){return null}})();
const[screen,setScreen]=useState(savedSession?savedSession.screen:'login');const[data,setData]=useState(null);const[empId,setEmpId]=useState(savedSession?savedSession.empId:null);
const savingRef=useRef(false);
const undoStack=useRef([]);
useEffect(()=>{try{localStorage.setItem('rm-session',JSON.stringify({screen,empId}))}catch(e){}},[screen,empId]);
useEffect(()=>{loadData().then(d=>setData(d));const unsub=subscribeToChanges((nd)=>{if(!savingRef.current)setData(nd)});return()=>unsub()},[]);
const doSave=useCallback(async nd=>{savingRef.current=true;undoStack.current=[...(undoStack.current||[]).slice(-19),JSON.stringify(data)];setData(nd);await saveData(nd);setTimeout(()=>{savingRef.current=false},2000)},[data]);
const doUndo=useCallback(async()=>{if(!undoStack.current||undoStack.current.length===0){alert('Rien a annuler');return}const prev=undoStack.current.pop();const prevData=JSON.parse(prev);savingRef.current=true;setData(prevData);await saveData(prevData);setTimeout(()=>{savingRef.current=false},2000)},[]);
const onLogin=(type,eid)=>{if(type==='admin'){setScreen('admin')}else{const emp=(data.employees||[]).find(e=>e.id===eid);setScreen(emp&&emp.role==='mechanic'?'mechanic':'employee')}if(eid)setEmpId(eid)};
const onLogout=()=>{setScreen('login');setEmpId(null);try{localStorage.removeItem('rm-session')}catch(e){}};
if(!data)return(<div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh'}}><div style={{fontSize:48}}>&#128679;</div></div>);
if(screen==='login')return(<LoginScreen data={data} onLogin={onLogin}/>);
if(screen==='mechanic')return(<MechanicView data={data} save={doSave} empId={empId} onLogout={onLogout}/>);
if(screen==='employee')return(<EmployeeView data={data} save={doSave} empId={empId} onLogout={onLogout}/>);
return(<AdminPanel data={data} save={doSave} onLogout={onLogout} onUndo={doUndo}/>);
};

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
