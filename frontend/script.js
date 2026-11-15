(function(){
var RM=matchMedia('(prefers-reduced-motion:reduce)').matches;
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)e.target.classList.add('in')})},{threshold:.35});
document.querySelectorAll('section').forEach(function(s){io.observe(s)});
document.getElementById('top').onclick=function(){scrollTo({top:0,behavior:RM?'auto':'smooth'})};
var labels=[['Status: idle','Floors: 04'],['Step 01 / prompt to plan','Floors: 04'],['Step 02 / 1 check failed','Floors: 04'],['Step 03 / fixed, all pass','Floors: 04'],['Step 04 / export STL','Floors: 04']];
var h1=document.getElementById('h1'),h2=document.getElementById('h2'),pct=document.getElementById('pct');
if(!window.THREE)return;
var T=THREE,ren;
try{ren=new T.WebGLRenderer({canvas:document.getElementById('gl'),antialias:true,alpha:true})}catch(e){return}
var scene=new T.Scene(),cam=new T.PerspectiveCamera(42,1,.1,80);
function css(){return new T.Color(getComputedStyle(document.documentElement).getPropertyValue('--fog').trim()||'#c9ced6')}
scene.fog=new T.FogExp2(css(),.04);
function theme(){scene.fog.color.copy(css())}
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',theme);
new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
scene.add(new T.HemisphereLight(0xffffff,0x8892a6,.9));
var sun=new T.DirectionalLight(0xffffff,.9);sun.position.set(6,10,5);scene.add(sun);
var slabM=new T.MeshStandardMaterial({color:0xdfe3ea,roughness:.4,metalness:.25}),
wallM=new T.MeshStandardMaterial({color:0xf2f4f8,transparent:true,opacity:.5,roughness:.5}),
divM=new T.MeshStandardMaterial({color:0xaab1bf,roughness:.6});
var grey=new T.Color(0x6b7385),amber=new T.Color(0xd9822b),house=new T.Group(),floors=[];
for(var i=0;i<4;i++){
 var g=new T.Group();
 g.add(new T.Mesh(new T.BoxGeometry(6,.2,4),slabM));
 var w=new T.Mesh(new T.BoxGeometry(6,1,4),wallM);w.position.y=.6;g.add(w);
 var em=new T.LineBasicMaterial({color:0x6b7385});
 var ed=new T.LineSegments(new T.EdgesGeometry(w.geometry),em);ed.position.y=.6;g.add(ed);
 var d=new T.Mesh(new T.BoxGeometry(.08,1,3.9),divM);d.position.set(-.8,.6,0);g.add(d);
 var st=new T.Mesh(new T.BoxGeometry(.9,1,1.2),divM);st.position.set(2.3,.6,-1.2);g.add(st);
 if(i===3){var rf=new T.Mesh(new T.BoxGeometry(6.3,.15,4.3),slabM);rf.position.y=1.2;g.add(rf)}
 house.add(g);floors.push({g:g,em:em});
}
scene.add(house);
var shards=[];
for(var k=0;k<16;k++){var m=new T.Mesh(new T.IcosahedronGeometry(.25+Math.random()*.5,0),new T.MeshStandardMaterial({color:0xe4e8ee,flatShading:true,roughness:.3,metalness:.3}));
 var a=Math.random()*6.28,r=7+Math.random()*9;m.position.set(Math.cos(a)*r,Math.random()*9-1,Math.sin(a)*r);m.userData.s=Math.random()*.4+.1;scene.add(m);shards.push(m)}
var pg=new T.BufferGeometry(),pa=[];for(var p=0;p<260;p++)pa.push((Math.random()-.5)*30,Math.random()*14-2,(Math.random()-.5)*30);
pg.setAttribute('position',new T.Float32BufferAttribute(pa,3));
scene.add(new T.Points(pg,new T.PointsMaterial({color:0xffffff,size:.05,transparent:true,opacity:.6})));
function size(){ren.setPixelRatio(Math.min(devicePixelRatio,2));ren.setSize(innerWidth,innerHeight,false);cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix()}
addEventListener('resize',size);size();
var mx=0,my=0,cur=0,last=-1;
addEventListener('pointermove',function(e){mx=e.clientX/innerWidth-.5;my=e.clientY/innerHeight-.5});
function sm(a,b,x){x=Math.min(1,Math.max(0,(x-a)/(b-a)));return x*x*(3-2*x)}
function frame(t){
 var max=document.documentElement.scrollHeight-innerHeight,tgt=max>0?scrollY/max*4:0;
 cur+=(tgt-cur)*(RM?1:.06);var s=cur;
 var e=sm(.5,1.5,s)*(1-.8*sm(3.2,4,s)),over=sm(1.2,1.9,s)*(1-sm(2.3,3,s));
 floors.forEach(function(f,i){f.g.position.y=i*(1.2+e*1.7);var k=i===2?1+.2*over:1;f.g.scale.set(k,1,k);f.em.color.copy(grey);if(i===2)f.em.color.lerp(amber,over)});
 var an=.7+s*.6+(RM?0:mx*.3),r=13-e*1.5;
 cam.position.set(Math.sin(an)*r,3.5+e*1.5+(RM?0:my*.8),Math.cos(an)*r);cam.lookAt(0,1.8+e*2.5,0);
 if(!RM){house.rotation.y=t*.00008;shards.forEach(function(m){m.rotation.x+=m.userData.s*.004;m.rotation.y+=m.userData.s*.005;m.position.y+=Math.sin(t*.0006+m.userData.s*10)*.002})}
 ren.render(scene,cam);
 var idx=Math.min(4,Math.round(s));if(idx!==last){last=idx;h1.textContent=labels[idx][0];h2.textContent=labels[idx][1]}
 pct.textContent=('00'+Math.round(Math.min(1,s/4)*100)).slice(-3);
 requestAnimationFrame(frame)}
requestAnimationFrame(frame);
})();
