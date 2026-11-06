const {app,BrowserWindow,desktopCapturer,screen}=require('electron');
const fs=require('fs'),path=require('path');
const assert=require('assert/strict');
const {PanelGlass}=require('../../app/panel-glass');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',process.env.ZER0NE_PANEL_TEST_DATA);
app.whenReady().then(async()=>{
 let back,front,glass;
 try{
  const display=screen.getPrimaryDisplay(); const bounds={x:display.workArea.x+80,y:display.workArea.y+80,width:1000,height:650};
  back=new BrowserWindow({...bounds,frame:false,show:false,alwaysOnTop:true,webPreferences:{sandbox:true}});
  await back.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:repeating-conic-gradient(#ffffff40 0% 25%,#0004 0% 50%) 0/16px 16px,linear-gradient(90deg,#d92f36 50%,#2465ef 50%);width:100vw;height:100vh"></body>'));
  back.showInactive();
  front=new BrowserWindow({...bounds,frame:false,transparent:true,backgroundColor:'#00000000',show:false,alwaysOnTop:true,webPreferences:{sandbox:true}});
  await front.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:transparent;color:white;font:24px sans-serif"><div style="height:40px;background:#111">Panel-only acrylic verification</div><div style="position:absolute;left:0;top:40px;width:250px;height:610px;background:#16161644">Projects<br>Native acrylic</div><div style="position:absolute;right:0;top:40px;width:250px;height:610px;background:#16161644">Work Details<br>Native acrylic</div><div style="margin-left:280px;margin-top:80px;color:red">Clear conversation</div></body>'));
  front.show();glass=new PanelGlass(front);glass.update({viewport:{width:1000,height:650},panels:[{id:'sidebar',x:0,y:40,width:250,height:610},{id:'auxiliary',x:750,y:40,width:250,height:610}]});
  await sleep(4500);
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:display.size.width*display.scaleFactor,height:display.size.height*display.scaleFactor}});
  const source=sources.find(s=>s.display_id===String(display.id))||sources[0];
  const image=source.thumbnail;const size=image.getSize();const factor=size.width/display.size.width;
  const crop=image.crop({x:Math.round((bounds.x-display.bounds.x)*factor),y:Math.round((bounds.y-display.bounds.y)*factor),width:Math.round(bounds.width*factor),height:Math.round(bounds.height*factor)});
  const file=path.resolve(__dirname,'../output/panel-native-desktop.png');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,crop.toPNG());
  assert(!glass.failed);assert(glass.windows.every(w=>w.isVisible()));
  const bitmap=crop.toBitmap(),pixels=crop.getSize();
  const sample=x=>{
   let red=0,blue=0,edge=0,count=0;
   for(let y=Math.round(250*factor);y<Math.round(400*factor);y++)for(let col=Math.round(x*factor);col<Math.round((x+100)*factor);col++){
    const i=(y*pixels.width+col)*4;blue+=bitmap[i];red+=bitmap[i+2];edge+=Math.abs(bitmap[i+2]-bitmap[i-2]);count++;
   }
   return {red:red/count,blue:blue/count,edge:edge/count};
  };
  const left=sample(80),right=sample(800),clear=sample(330);
  console.log('Samples:',left,right,clear);
  assert(clear.edge>2,'The center must retain sharp checkerboard edges');
  assert(left.edge<clear.edge/4&&right.edge<clear.edge/4,'Only the panels must blur the checkerboard');
  assert(left.red>left.blue+8&&right.blue>right.red+8,'Native panels must retain colors from the actual background');
  front.minimize();await sleep(250);assert(glass.windows.every(w=>!w.isVisible()),'Minimizing hides native panel surfaces');
  front.restore();await sleep(250);assert(glass.windows.every(w=>w.isVisible()));
  front.setBounds({...bounds,x:bounds.x+30,y:bounds.y+20,width:1100,height:700});await sleep(250);
  assert(Math.abs(glass.windows[0].getBounds().width-front.getContentBounds().width*.25)<2,'Native regions follow window resizing');
  assert.equal(glass.windows[0].getBounds().x,front.getContentBounds().x,'Moving keeps the panel aligned');
  glass.update({viewport:{width:1100,height:700},panels:[{id:'sidebar',x:0,y:40,width:200,height:660}]});await sleep(250);
  assert(glass.windows[0].isVisible()&&!glass.windows[1].isVisible(),'Closing one panel hides only its native surface');
  assert(Math.abs(glass.windows[0].getBounds().width-200)<2,'Dragging a panel updates its material width');
  glass.clear();await sleep(250);assert(glass.windows.every(w=>!w.isVisible()),'Solid mode or hidden panels removes the surfaces');
  console.log('Native panel blur passed:',JSON.stringify({left,right,clear}));
  await sleep(200);
 }catch(error){console.error(error);process.exitCode=1;}
 finally{glass?.dispose();front?.destroy();back?.destroy();app.exit(process.exitCode||0);}
});
