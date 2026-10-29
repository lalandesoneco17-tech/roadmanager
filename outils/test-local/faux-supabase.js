// Faux Supabase EN MEMOIRE pour tester RoadManager sans toucher la vraie base.
// Imite la partie du client supabase-js utilisee par l'app : from().select/eq/gt/order/range/limit/single/maybeSingle,
// upsert (avec ignoreDuplicates), update().eq().select(), channel().on().subscribe(), removeChannel().
// Les tables, le journal des ecritures et l'interrupteur « hors ligne » sont visibles dans window.fauxSupabase.__etat.
(function(){
const iso=d=>new Date(d).toISOString();
const jour=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const COLS_TE=['id','emp_id','date','type','start_time','end_time','pause_start','pause_end','pause_min','break_start','break_end','meal_type','absence_type','night_hours','requested_end_time','requested_end_motif','ref_hours','pauses','positions','created_at','updated_at','deleted'];
// ---- jeu de donnees ----
const seedData={adminUser:'admin',adminPass:'admin',
 employees:[{id:'e1',name:'Test Chauffeur',login:'test',role:'employee'},{id:'e2',name:'Autre Chauffeur',login:'autre',role:'employee'},{id:'e3',name:'Gros Volume',login:'gros',role:'employee'}],
 empPasswords:{e1:'1234',e2:'1234',e3:'1234'},
 machines:[{id:'m1',name:'W 100',type:'Raboteuse',width:100}],clients:[{id:'c1',name:'Client Test'}],depots:[{id:'d1',name:'Depot test',lat:45.7,lon:-0.6}],
 jobs:[{id:'j1',date:jour(-1),employeeId:'e2',machineId:'m1',clientId:'c1',location:'Route test',startTime:'08:00'},{id:'j2',date:jour(-3),employeeId:'e2',machineId:'m1',clientId:'c1',location:'Route test',startTime:'08:00'},{id:'j3',date:jour(-1),employeeId:'e1',machineId:'m1',clientId:'c1',location:'Giratoire test',startTime:'07:00'}]};
const te=[];let k=0;
// 10 jours de pointages termines pour e1 (dont un supprime = corbeille)
for(let i=12;i>=2;i--){te.push({id:'te'+(++k),emp_id:'e1',date:jour(-i),type:'done',start_time:'07:00',end_time:'17:00',pause_min:60,break_start:'12:00',break_end:'13:00',meal_type:'PANIER',pauses:[{d:'12:00',f:'13:00'}],created_at:iso(Date.now()-i*864e5),updated_at:iso(Date.now()-i*864e5),deleted:i===5})}
// pointage d'hier de e1 : embauche puis debauche
te.push({id:'te'+(++k),emp_id:'e1',date:jour(-1),type:'done',start_time:'07:05',end_time:'16:40',pause_min:45,break_start:'12:10',break_end:'12:55',meal_type:'PANIER',pauses:[{d:'12:10',f:'12:55'}],created_at:iso(Date.now()-864e5),updated_at:iso(Date.now()-864e5),deleted:false});
// 1 050 lignes pour e3 : verifie la lecture par pages de 1000
for(let i=0;i<1050;i++){const d=new Date(2025,0,1);d.setDate(d.getDate()+Math.floor(i/3));te.push({id:'gros'+i,emp_id:'e3',date:d.toISOString().slice(0,10),type:'done',start_time:'08:00',end_time:'16:00',pause_min:60,created_at:iso(d),updated_at:iso(d),deleted:false})}
const tables={app_data:[{id:'main',data:seedData,updated_at:iso(Date.now())}],time_entries:te,time_entries_validated:[],machines_jd:[]};
const etat={offline:false,journal:[],canaux:[],tables,nbRequetes:0};
const clone=x=>JSON.parse(JSON.stringify(x));
const notifier=(table,evt,row)=>{setTimeout(()=>{etat.canaux.forEach(c=>c.subs.forEach(s=>{if(s.filtre&&s.filtre.table===table&&(s.filtre.event==='*'||s.filtre.event===evt)){try{s.cb({eventType:evt,new:clone(row),old:{}})}catch(e){console.warn('faux realtime',e)}}}))},60)};
const projeter=(r,cols)=>{if(!cols||cols==='*')return clone(r);const o={};cols.split(',').map(s=>s.trim()).forEach(c=>{if(c in r)o[c]=clone(r[c])});return o};
function Req(table){this.table=table;this.filtres=[];this.mode='select';this.cols='*';this.un=null;this.rg=null;this.ordre=[];this.retour=false;this.opts={}}
const P=Req.prototype;
P.select=function(cols){if(this.mode==='select')this.cols=cols||'*';else this.retour=true;return this};
P.eq=function(c,v){this.filtres.push(r=>String(r[c])===String(v));return this};
P.gt=function(c,v){this.filtres.push(r=>r[c]!=null&&iso(r[c])>iso(v));return this};
P.order=function(c,o){this.ordre.push([c,!(o&&o.ascending===false)]);return this};
P.limit=function(n){this.rg=[0,n-1];return this};
P.range=function(a,b){this.rg=[a,b];return this};
P.single=function(){this.un='un';return this};
P.maybeSingle=function(){this.un='peut';return this};
P.upsert=function(row,opts){this.mode='upsert';this.payload=row;this.opts=opts||{};return this};
P.update=function(obj){this.mode='update';this.payload=obj;return this};
P.insert=function(row){this.mode='insert';this.payload=row;return this};
P.then=function(res,rej){return this.exec().then(res,rej)};
P.exec=async function(){await new Promise(r=>setTimeout(r,25));etat.nbRequetes++;
 if(etat.offline)return{data:null,error:{message:'TypeError: Failed to fetch',code:'OFFLINE'}};
 const T=tables[this.table];if(!T)return{data:null,error:{message:'relation "'+this.table+'" does not exist',code:'42P01'}};
 const connues=(this.table==='time_entries'||this.table==='time_entries_validated')?COLS_TE:null;
 const verif=row=>{if(!connues)return null;const m=Object.keys(row).find(c=>!connues.includes(c));return m?{message:"Could not find the '"+m+"' column of '"+this.table+"' in the schema cache",code:'PGRST204'}:null};
 if(this.mode==='upsert'||this.mode==='insert'){const rows=Array.isArray(this.payload)?this.payload:[this.payload];for(const r of rows){const err=verif(r);if(err)return{data:null,error:err};const i=T.findIndex(x=>x.id===r.id);if(i>=0){if(this.mode==='insert')return{data:null,error:{message:'duplicate key',code:'23505'}};if(this.opts.ignoreDuplicates){etat.journal.push({t:this.table,op:'upsert-ignore',id:r.id});continue}T[i]={...T[i],...clone(r)};etat.journal.push({t:this.table,op:'upsert-maj',id:r.id,row:clone(T[i])});notifier(this.table,'UPDATE',T[i])}else{T.push(clone(r));etat.journal.push({t:this.table,op:'insert',id:r.id,row:clone(r)});notifier(this.table,'INSERT',r)}}return{data:this.retour?clone(rows):null,error:null}}
 if(this.mode==='update'){const err=verif(this.payload);if(err)return{data:null,error:err};const touchees=T.filter(r=>this.filtres.every(f=>f(r)));touchees.forEach(r=>{Object.assign(r,clone(this.payload));etat.journal.push({t:this.table,op:'update',id:r.id,champs:Object.keys(this.payload),row:clone(r)});notifier(this.table,'UPDATE',r)});return{data:this.retour?touchees.map(r=>({id:r.id})):null,error:null}}
 let rows=T.filter(r=>this.filtres.every(f=>f(r)));
 for(let i=this.ordre.length-1;i>=0;i--){const[c,asc]=this.ordre[i];rows=rows.slice().sort((a,b)=>{const x=a[c]==null?'':String(a[c]),y=b[c]==null?'':String(b[c]);return(x<y?-1:x>y?1:0)*(asc?1:-1)})}
 if(this.rg)rows=rows.slice(this.rg[0],this.rg[1]+1);else rows=rows.slice(0,1000); // comme PostgREST : 1000 lignes max sans range
 rows=rows.map(r=>projeter(r,this.cols));
 if(this.un==='un')return rows.length===1?{data:rows[0],error:null}:{data:null,error:{message:'JSON object requested, multiple (or no) rows returned',code:'PGRST116'}};
 if(this.un==='peut')return{data:rows[0]||null,error:null};
 return{data:rows,error:null}};
function Canal(nom){this.nom=nom;this.subs=[]}
Canal.prototype.on=function(type,filtre,cb){this.subs.push({type,filtre,cb});return this};
Canal.prototype.subscribe=function(cb){etat.canaux.push(this);if(cb)try{cb('SUBSCRIBED')}catch(e){}return this};
window.fauxSupabase={from:t=>new Req(t),channel:n=>new Canal(n),removeChannel:c=>{etat.canaux=etat.canaux.filter(x=>x!==c)},__etat:etat,
 // simule une autre machine qui ecrit dans la table (pour tester le temps reel)
 __ecrireAilleurs:(table,row)=>{const T=tables[table];const i=T.findIndex(x=>x.id===row.id);if(i>=0){Object.assign(T[i],row);notifier(table,'UPDATE',T[i])}else{T.push(row);notifier(table,'INSERT',row)}}};
console.log('Faux Supabase pret :',te.length,'pointages,',seedData.employees.length,'salaries (admin/admin, test/1234)');
})();
