'use strict';
if(process.platform!=='win32'){console.log('Native panel acrylic is Windows-only.');process.exit(0);}
const path=require('path'),{spawnSync}=require('child_process');
const fs=require('fs'),os=require('os');
// Windows renders acrylic as a solid surface when transparency effects are off or battery saver
// runs; the fixture would sample that fallback, not a missing material. Report the OS state.
function acrylicAvailable(){
 try{
  const script=`
   $t=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name EnableTransparency -ErrorAction SilentlyContinue).EnableTransparency
   Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PS{[StructLayout(LayoutKind.Sequential)]public struct S{public byte AC;public byte BF;public byte BL;public byte SS;public int LT;public int FT;}[DllImport("kernel32.dll")]public static extern bool GetSystemPowerStatus(out S s);}'
   $s=New-Object PS+S;[void][PS]::GetSystemPowerStatus([ref]$s)
   'T=' + $t + ' S=' + $s.SS`;
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:15000,windowsHide:true});
  const out=(r.stdout||'').replace(/\s+$/,'');
  const transparency=/T=(\d+)/.exec(out)?.[1];
  const saver=/S=(\d+)/.exec(out)?.[1];
  return transparency==='1' && saver!=='1';
 }catch{return true;}
}
// Hosted CI runners have no composited desktop to sample, and PowerShell started from Electron there cannot compile the helper.
if(process.env.GITHUB_ACTIONS){console.log('Native panel acrylic needs a real desktop; skipping the visual fixture on a CI runner.');process.exit(0);}
if(!acrylicAvailable()){console.log('Native panel acrylic is disabled by Windows (transparency effects off or battery saver); skipping the visual fixture.');process.exit(0);}
const data=fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-panel-glass-'));
const release=require('./gui-lock').acquire();
try{
 const env={...process.env,ZER0NE_PANEL_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
 const result=spawnSync(require('electron'),[path.join(__dirname,'fixtures/panel-glass-visual.cjs')],{env,stdio:'inherit',timeout:30000});
 if(result.status!==0){console.error('Native panel fixture failed:',result.error?.message||`exit ${result.status}, signal ${result.signal||'none'}`);process.exitCode=1;}
}finally{release();fs.rmSync(data,{recursive:true,force:true});}
