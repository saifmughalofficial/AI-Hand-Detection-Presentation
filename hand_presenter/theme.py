"""Holographic cyber theme: global CSS, animated background and the CSS-3D dotted globe."""
from __future__ import annotations

import math
import random
from functools import lru_cache

from .worldmask import is_land

GREEN = "#00ff66"

_CSS = r"""
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Rajdhani:wght@500;700&family=Share+Tech+Mono&display=swap');

:root {
  --g: #00ff66; --g-hi: #c8ffd9; --g-faint: rgba(0,255,102,.12); --line: rgba(0,255,102,.26);
  --line-strong: rgba(0,255,102,.62); --panel: rgba(1,13,6,.84); --text: #cfffe0; --muted: #69b886;
  --amber: #ffc94d; --red: #ff4d6d; --mono: "Share Tech Mono", Consolas, monospace;
  --display: "Orbitron", "Segoe UI", sans-serif; --ui: "Rajdhani", "Segoe UI", sans-serif;
  --hp-hx: 0; --hp-hy: 0;
}

/* ---------- Streamlit chrome */
header[data-testid="stHeader"], #MainMenu, footer, [data-testid="stToolbar"], [data-testid="stDecoration"] { display: none !important; }
.stApp, [data-testid="stAppViewContainer"] { background: #010603 !important; color: var(--text); font-family: var(--ui); }
[data-testid="stMainBlockContainer"], .block-container { padding: 10px 14px 6px !important; max-width: 100% !important; position: relative; z-index: 3; }
[data-stale="true"] { opacity: 1 !important; transition: none !important; }
[data-testid="stVerticalBlock"] { gap: .45rem; }
p, label, span, div { font-family: var(--ui); }
.hp-state { display: none !important; }

/* ---------- widgets */
.stButton > button, [data-testid^="stBaseButton"] {
  border-radius: 0 !important; border: 1px solid var(--line) !important; background: rgba(0,255,102,.05) !important;
  color: var(--g) !important; font: 700 13px var(--ui) !important; letter-spacing: .12em; text-transform: uppercase;
  clip-path: polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); min-height: 36px;
}
.stButton > button:hover:not(:disabled) { background: rgba(0,255,102,.17) !important; color: var(--g-hi) !important; text-shadow: 0 0 8px var(--g); }
.stButton > button:disabled { opacity: .3; }
.stButton > button[kind="primary"] { background: linear-gradient(90deg,#00d957,#00ff88) !important; color: #001a09 !important; border-color: transparent !important; }
.stButton > button p { font: inherit !important; }
[data-testid="stFileUploaderDropzone"] {
  background: rgba(0,18,7,.82) !important; border: 1px dashed var(--line-strong) !important; border-radius: 0 !important; padding: 8px 14px !important;
}
[data-testid="stFileUploaderDropzone"] button { border-radius: 0 !important; }
[data-testid="stFileUploaderDropzoneInstructions"] span, [data-testid="stFileUploaderDropzoneInstructions"] small { color: var(--muted) !important; }
[data-testid="stExpander"] details { border: 1px solid var(--line) !important; border-radius: 0 !important; background: var(--panel); }
[data-testid="stExpander"] summary { font: 13px var(--mono); letter-spacing: .12em; color: var(--g); }
[data-testid="stButtonGroup"] button { border-radius: 0 !important; font: 700 12px var(--ui) !important; letter-spacing: .1em; text-transform: uppercase; }
[data-testid="stWidgetLabel"] p { font: 12px var(--mono) !important; letter-spacing: .1em; text-transform: uppercase; color: var(--muted) !important; }

/* ---------- background */
.hp-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
         background: radial-gradient(ellipse at 40% 35%, rgba(0,60,24,.35), transparent 60%), #010603; }
.hp-rain { position: absolute; inset: 0; opacity: .5; transition: opacity .8s; }
.hp-col { position: absolute; top: 0; width: 1ch; font: 15px/1.05 var(--mono); color: var(--g); word-break: break-all;
          text-shadow: 0 0 6px rgba(0,255,102,.7); animation: hp-fall linear infinite;
          -webkit-mask-image: linear-gradient(to bottom, transparent, #000 75%, #fff); mask-image: linear-gradient(to bottom, transparent, #000 75%); }
@keyframes hp-fall { from { transform: translateY(-110%); } to { transform: translateY(110vh); } }
.hp-city { position: absolute; left: 0; right: 0; bottom: 18vh; height: 34vh; display: flex; align-items: flex-end; gap: 6px; opacity: .55; }
.hp-city i { flex: 1; background: linear-gradient(#021208, #010603);
             border: 1px solid rgba(0,255,102,.2); border-bottom: 0;
             background-image: radial-gradient(rgba(0,255,102,.55) 1px, transparent 1.6px); background-size: 9px 13px; }
.hp-floor { position: absolute; left: -50vw; right: -50vw; bottom: -12vh; height: 42vh; transform: perspective(500px) rotateX(68deg);
            background-image: linear-gradient(rgba(0,255,102,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,102,.35) 1px, transparent 1px);
            background-size: 60px 60px; animation: hp-floor 4s linear infinite; opacity: .5;
            -webkit-mask-image: linear-gradient(transparent, #000 45%); mask-image: linear-gradient(transparent, #000 45%); }
@keyframes hp-floor { to { background-position: 0 60px; } }
.hp-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at 45% 50%, transparent 45%, rgba(0,0,0,.78) 100%); }
.hp-scan { position: fixed; inset: 0; z-index: 50; pointer-events: none; opacity: .28;
           background: repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,.22) 3px, transparent 4px); }
body:has(.hp-loaded) .hp-rain { opacity: .18; }
body.hp-presenting .hp-scan { display: none; }

/* ---------- panels & HUD text */
.hp-panel { position: relative; background: var(--panel); border: 1px solid var(--line); box-shadow: inset 0 0 40px rgba(0,255,102,.04);
            clip-path: polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px); }
.hp-head { display: flex; align-items: center; gap: 10px; padding: 7px 14px 7px 16px; border: 1px solid var(--line);
           background: rgba(1,13,6,.88); font: 13px var(--mono); letter-spacing: .12em; color: var(--g); text-shadow: 0 0 8px rgba(0,255,102,.7); }
.hp-head .grow { flex: 1; }
.hp-pill { padding: 1px 9px; border: 1px solid var(--line); color: var(--muted); font: 12px var(--mono); letter-spacing: .14em; }
.hp-pill.live { background: var(--g); color: #001a09; border-color: var(--g); box-shadow: 0 0 12px var(--g); text-shadow: none; }
.hp-pill.paused { color: var(--amber); border-color: var(--amber); }
.hp-dots { display: inline-flex; gap: 5px; } .hp-dots i { width: 8px; height: 8px; border: 1px solid var(--line-strong); }

.hp-topbar { display: flex; align-items: center; gap: 16px; padding: 6px 16px; border: 1px solid var(--line); border-bottom-color: var(--line-strong);
             background: linear-gradient(90deg, rgba(0,20,8,.9), rgba(0,10,4,.65)); box-shadow: 0 6px 30px -12px rgba(0,255,102,.35); }
.hp-brand { display: flex; align-items: center; gap: 12px; }
.hp-brand svg { width: 40px; height: 40px; filter: drop-shadow(0 0 6px var(--g)); }
.hp-title { position: relative; margin: 0; font: 900 20px/1.1 var(--display); letter-spacing: .14em; color: var(--g-hi);
            text-shadow: 0 0 10px rgba(0,255,102,.8), 0 0 24px rgba(0,255,102,.4); white-space: nowrap; }
.hp-title::after { content: attr(data-text); position: absolute; inset: 0; color: #3dfcff; opacity: 0; animation: hp-glitch 5s infinite steps(1); }
@keyframes hp-glitch { 0%,91%,100% { opacity: 0; } 92% { opacity: .8; transform: translate(-3px,1px); clip-path: inset(10% 0 55% 0); }
                       94% { opacity: .8; transform: translate(3px,-1px); clip-path: inset(60% 0 8% 0); } }
.hp-sub { font: 11px var(--mono); letter-spacing: .32em; color: var(--muted); }
.hp-chips { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.hp-chip { padding: 4px 10px; border: 1px solid var(--line); font: 700 12px var(--ui); letter-spacing: .16em; color: var(--g); background: rgba(0,255,102,.05); white-space: nowrap; }
.hp-chip.mono { font: 12px var(--mono); letter-spacing: .06em; }
.hp-clock { font: 18px var(--mono); color: var(--g-hi); text-shadow: 0 0 8px var(--g); letter-spacing: .08em; min-width: 92px; text-align: right; }

/* ---------- stage */
.hp-stage-wrap { position: relative; height: 70vh; min-height: 420px; border: 1px solid var(--line); background: rgba(1,13,6,.18); overflow: hidden; }
.hp-stage-wrap.hp-loaded { background-color: rgba(0,5,2,.8);
  background-image: linear-gradient(rgba(0,255,102,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,102,.04) 1px, transparent 1px);
  background-size: 40px 40px; }
.hp-corners i { position: absolute; width: 18px; height: 18px; border: 2px solid var(--g); opacity: .75; z-index: 4; pointer-events: none; }
.hp-corners i:nth-child(1) { top: 8px; left: 8px; border-right: 0; border-bottom: 0; }
.hp-corners i:nth-child(2) { top: 8px; right: 8px; border-left: 0; border-bottom: 0; }
.hp-corners i:nth-child(3) { bottom: 8px; right: 8px; border-left: 0; border-top: 0; }
.hp-corners i:nth-child(4) { bottom: 8px; left: 8px; border-right: 0; border-top: 0; }
.hp-stage { position: absolute; inset: 0; display: flex; overflow: auto; padding: 22px; perspective: 1800px; }
.hp-stage img.hp-zoomable { flex: none; margin: auto; display: block; background: #fff; transition: transform .14s linear;
  box-shadow: 0 0 0 1px rgba(0,255,102,.55), 0 0 42px rgba(0,255,102,.22), 0 30px 80px rgba(0,0,0,.85); }
.hp-anim-xp { animation: hp-in-xp .62s cubic-bezier(.16,1,.3,1) both; }
.hp-anim-xm { animation: hp-in-xm .62s cubic-bezier(.16,1,.3,1) both; }
.hp-anim-yp { animation: hp-in-yp .62s cubic-bezier(.16,1,.3,1) both; }
.hp-anim-ym { animation: hp-in-ym .62s cubic-bezier(.16,1,.3,1) both; }
.hp-anim-zoom { animation: hp-in-zoom .4s cubic-bezier(.16,1,.3,1) both; }
.hp-anim-load { animation: hp-in-load .7s cubic-bezier(.16,1,.3,1) both; }
@keyframes hp-in-xp { from { transform: translate3d(38%,0,-260px) rotateY(-62deg); opacity: 0; filter: brightness(2); } }
@keyframes hp-in-xm { from { transform: translate3d(-38%,0,-260px) rotateY(62deg); opacity: 0; filter: brightness(2); } }
@keyframes hp-in-yp { from { transform: translate3d(0,45%,-260px) rotateX(55deg); opacity: 0; filter: brightness(2); } }
@keyframes hp-in-ym { from { transform: translate3d(0,-45%,-260px) rotateX(-55deg); opacity: 0; filter: brightness(2); } }
@keyframes hp-in-zoom { from { transform: scale(var(--hp-zfrom, .85)); filter: brightness(1.25); } }
@keyframes hp-in-load { from { transform: scale(.9) rotateX(10deg); opacity: 0; filter: brightness(2.2) blur(3px); } }
.hp-scanline { position: absolute; inset: 0; pointer-events: none; z-index: 3;
  background: linear-gradient(to bottom, transparent 0%, rgba(0,255,102,.25) 46%, rgba(210,255,225,.75) 50%, rgba(0,255,102,.25) 54%, transparent 100%);
  background-size: 100% 300%; animation: hp-scan-sweep .95s ease-out forwards; mix-blend-mode: screen; }
@keyframes hp-scan-sweep { from { background-position: 0 100%; } to { background-position: 0 0; opacity: 0; } }

.hp-doc { position: absolute; inset: 0; overflow: auto; padding: 26px 56px 40vh; }
.hp-doc-pages { display: flex; flex-direction: column; gap: 22px; transform-origin: 50% 0; transition: transform .14s linear; }
.hp-doc-page { position: relative; margin: 0 auto; box-shadow: 0 0 0 1px rgba(0,255,102,.3), 0 14px 40px rgba(0,0,0,.75); background: #fff; }
.hp-doc-page.current { box-shadow: 0 0 0 1px var(--g), 0 0 34px rgba(0,255,102,.3), 0 14px 40px rgba(0,0,0,.75); }
.hp-doc-page img { display: block; width: 100%; }
.hp-doc-page span { position: absolute; top: 2px; left: -44px; font: 12px var(--mono); color: var(--muted); }
.hp-doc-page.current span { color: var(--g); text-shadow: 0 0 8px var(--g); }
.hp-paper { max-width: 900px; margin: 0 auto; padding: 60px 70px; background: #fff; color: #161b18; font: 400 16px/1.6 Calibri, "Segoe UI", sans-serif;
            box-shadow: 0 0 0 1px rgba(0,255,102,.4), 0 14px 40px rgba(0,0,0,.75); }
.hp-paper * { color: #161b18; font-family: Calibri, "Segoe UI", sans-serif; }
.hp-progress { height: 3px; background: var(--g-faint); margin-top: 4px; }
.hp-progress div { height: 100%; background: var(--g); box-shadow: 0 0 10px var(--g); transition: width .45s cubic-bezier(.16,1,.3,1); }

/* ---------- home + CSS-3D globe */
.hp-home { position: absolute; inset: 0; display: grid; grid-template-columns: 230px 1fr 230px; grid-template-rows: auto 1fr auto; padding: 18px 22px; gap: 12px; }
.hp-home-center { grid-column: 2; text-align: center; }
.hp-eyebrow { font: 13px var(--mono); letter-spacing: .3em; color: var(--muted); text-shadow: 0 0 6px #000; }
.hp-hero { margin: 6px 0 4px; font: 900 clamp(26px,3.2vw,46px)/1.05 var(--display); letter-spacing: .08em; color: var(--g-hi);
           text-shadow: 0 0 16px rgba(0,255,102,.6), 0 0 40px rgba(0,255,102,.3); }
.hp-hero em { font-style: normal; color: var(--g); }
.hp-hero-sub { margin: 0; font-size: 17px; color: var(--text); text-shadow: 0 0 6px #000, 0 0 14px #000; }
.hp-side { display: flex; flex-direction: column; gap: 12px; grid-row: 1 / 3; }
.hp-side.right { grid-column: 3; }
.hp-mini { padding: 9px 12px; border: 1px solid var(--line); background: rgba(0,12,5,.78); font: 12px var(--mono); color: var(--text); }
.hp-mini b.h { display: block; color: var(--g); letter-spacing: .14em; margin-bottom: 6px; text-shadow: 0 0 6px var(--g); font-weight: 400; }
.hp-mini table { width: 100%; border-collapse: collapse; } .hp-mini td { padding: 2px 0; border-top: 1px dashed rgba(0,255,102,.12); }
.hp-mini td:first-child { color: var(--g); width: 22px; }
.hp-words { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }
.hp-words span { font: 700 14px var(--display); letter-spacing: .34em; color: var(--g); padding-left: 10px; border-left: 2px solid var(--g);
                 text-shadow: 0 0 10px var(--g); animation: hp-word 4s ease-in-out infinite; }
.hp-words span:nth-child(2) { animation-delay: 1s; } .hp-words span:nth-child(3) { animation-delay: 2s; } .hp-words span:nth-child(4) { animation-delay: 3s; }
@keyframes hp-word { 0%,100% { opacity: .45; } 12% { opacity: 1; color: var(--g-hi); } }
.hp-steps { grid-column: 1 / -1; display: flex; justify-content: center; flex-wrap: wrap; gap: 8px 22px; font-size: 15px; color: var(--text); }
.hp-steps b { font: 700 12px var(--display); color: var(--g); margin-right: 7px; }

.hp-globe-zone { position: absolute; left: 50%; top: 54%; width: 0; height: 0; pointer-events: none; }
.hp-beam { position: absolute; left: -45px; width: 90px; top: -50vh; height: 100vh;
           background: linear-gradient(90deg, transparent, rgba(0,255,102,.22) 35%, rgba(190,255,215,.85) 50%, rgba(0,255,102,.22) 65%, transparent);
           filter: blur(2px); animation: hp-beam 3s ease-in-out infinite; }
@keyframes hp-beam { 50% { opacity: .65; } }
.hp-glow { position: absolute; left: -190px; top: -190px; width: 380px; height: 380px; border-radius: 50%;
           background: radial-gradient(circle, rgba(0,26,11,.96) 52%, rgba(0,255,102,.55) 56%, rgba(0,255,102,.12) 64%, transparent 72%); }
.hp-ripple { position: absolute; left: -260px; top: 120px; width: 520px; height: 130px; border-radius: 50%; border: 2px solid rgba(0,255,102,.55);
             animation: hp-ripple 3s ease-out infinite; box-shadow: 0 0 24px rgba(0,255,102,.4); }
.hp-ripple.r2 { animation-delay: 1s; } .hp-ripple.r3 { animation-delay: 2s; }
@keyframes hp-ripple { from { transform: scale(.25); opacity: 1; } to { transform: scale(1.3); opacity: 0; } }
.hp-globe-tilt { position: absolute; left: 0; top: 0; perspective: 900px; transform-style: preserve-3d;
                 transform: rotateX(calc(var(--hp-hy) * -40deg)) rotateZ(calc(var(--hp-hx) * -25deg)); transition: transform .3s ease-out; }
.hp-globe { position: absolute; left: 0; top: 0; transform-style: preserve-3d; animation: hp-spin 36s linear infinite; }
@keyframes hp-spin { from { transform: rotateX(-14deg) rotateY(0deg); } to { transform: rotateX(-14deg) rotateY(360deg); } }
.hp-globe i { position: absolute; left: -2.5px; top: -2.5px; width: 5px; height: 5px; border-radius: 50%; background: #8dffb8;
              backface-visibility: hidden; box-shadow: 0 0 4px rgba(0,255,102,.9); }
.hp-globe i.c { width: 9px; height: 9px; left: -4.5px; top: -4.5px; background: #fff; box-shadow: 0 0 10px #fff, 0 0 18px var(--g); }
.hp-globe b { position: absolute; left: -160px; top: -160px; width: 320px; height: 320px; border-radius: 50%; border: 1px solid rgba(0,255,102,.16); }
.hp-orbit { position: absolute; border-radius: 50%; border: 1px solid rgba(0,255,102,.4); animation: hp-orbit linear infinite; }
.hp-orbit::after { content: ""; position: absolute; top: -5px; left: 50%; width: 10px; height: 10px; border-radius: 50%; background: #c8ffd9; box-shadow: 0 0 12px var(--g), 0 0 22px var(--g); }
.hp-orbit.o1 { left: -230px; top: -230px; width: 460px; height: 460px; --tilt: rotateX(72deg) rotateY(14deg); animation-duration: 14s; }
.hp-orbit.o2 { left: -265px; top: -265px; width: 530px; height: 530px; --tilt: rotateX(66deg) rotateY(-24deg); animation-duration: 22s; border-style: dashed; }
.hp-orbit.o3 { left: -205px; top: -205px; width: 410px; height: 410px; --tilt: rotateX(78deg) rotateY(-6deg); animation-duration: 9s; animation-direction: reverse; }
@keyframes hp-orbit { from { transform: var(--tilt) rotateZ(0deg); } to { transform: var(--tilt) rotateZ(360deg); } }
.hp-hex { position: absolute; width: 64px; height: 64px; opacity: .8; animation: hp-bob 5s ease-in-out infinite; filter: drop-shadow(0 0 8px var(--g)); }
@keyframes hp-bob { 50% { transform: translateY(-12px); opacity: .5; } }

/* ---------- right panel */
.hp-readout { display: grid; grid-template-columns: 92px 1fr; gap: 12px; align-items: center; padding: 8px 12px; }
.hp-compass { position: relative; width: 92px; height: 92px; }
.hp-compass .ring { position: absolute; inset: 21px; border: 1px dashed var(--line-strong); border-radius: 50%; }
.hp-compass .a { position: absolute; font-size: 14px; color: rgba(0,255,102,.3); }
.hp-compass .a.hit { color: var(--g-hi); text-shadow: 0 0 12px var(--g); }
.hp-compass .u { top: 0; left: 50%; transform: translateX(-50%); } .hp-compass .d { bottom: 0; left: 50%; transform: translateX(-50%); }
.hp-compass .l { left: 0; top: 50%; transform: translateY(-50%); } .hp-compass .r { right: 0; top: 50%; transform: translateY(-50%); }
.hp-compass .dot { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
                   background: var(--g); box-shadow: 0 0 12px var(--g); transition: transform .12s linear; }
.hp-compass.idle .dot { background: rgba(0,255,102,.25); box-shadow: none; }
.hp-compass.rearm .dot { background: var(--amber); box-shadow: 0 0 12px var(--amber); } .hp-compass.rearm .ring { border-color: var(--amber); }
.hp-mv label { font: 11px var(--mono); letter-spacing: .24em; color: var(--muted); }
.hp-mv .v { font: 900 22px/1.15 var(--display); letter-spacing: .08em; color: var(--g-hi); text-shadow: 0 0 12px var(--g); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-mv .v.warn { color: var(--amber); text-shadow: 0 0 12px rgba(255,201,77,.6); }
.hp-mv .s { font-size: 14px; color: var(--muted); }
.hp-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.hp-stats div { padding: 5px 8px; background: rgba(0,12,5,.95); }
.hp-stats label { display: block; font: 10px var(--mono); letter-spacing: .16em; color: var(--muted); }
.hp-stats b { font: 700 15px var(--display); color: var(--g-hi); }
.hp-stats b.warn { color: var(--amber); }
.hp-log { height: 150px; overflow-y: auto; padding: 8px 12px; font: 12px/1.5 var(--mono); color: var(--muted); }
.hp-log .ok { color: var(--g); } .hp-log .warn { color: var(--amber); } .hp-log .err { color: var(--red); }
.hp-keys { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; padding: 10px 14px; font-size: 14px; color: var(--muted); }
.hp-keys kbd { display: inline-block; min-width: 22px; margin-right: 3px; padding: 1px 6px; border: 1px solid var(--line-strong); border-bottom-width: 2px;
               font: 12px var(--mono); color: var(--g-hi); text-align: center; background: rgba(0,255,102,.06); }
.hp-status { display: flex; align-items: center; gap: 10px; padding: 6px 14px; border: 1px solid var(--line); background: rgba(0,12,5,.88); font-size: 14px; }
.hp-status .led { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.hp-status .led.on { background: var(--g); box-shadow: 0 0 10px var(--g); animation: hp-blink 1.2s infinite; }
.hp-status .msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-status .right { font: 13px var(--mono); color: var(--g); letter-spacing: .08em; white-space: nowrap; }
@keyframes hp-blink { 50% { opacity: .3; } }
.hp-page-info { font: 15px var(--mono); color: var(--g-hi); letter-spacing: .1em; text-shadow: 0 0 8px rgba(0,255,102,.5); text-align: center; padding-top: 7px; }

/* ---------- overlays driven by the camera script */
.hp-ov { position: fixed; z-index: 9995; pointer-events: none; }
.hp-flash { position: absolute; inset: 0; display: grid; place-items: center; transform: rotate(var(--rot,0deg)); }
.hp-flash span { font: 900 130px/1 var(--display); color: var(--g); opacity: 0; text-shadow: 0 0 30px var(--g); letter-spacing: -.1em; }
.hp-flash.go span { animation: hp-dir .7s cubic-bezier(.2,.8,.2,1); }
.hp-flash.zoom span { animation: hp-dirz .6s cubic-bezier(.2,.8,.2,1); letter-spacing: 0; }
@keyframes hp-dir { 0% { opacity: 0; transform: translateX(-120px); } 35% { opacity: .55; } 100% { opacity: 0; transform: translateX(140px); } }
@keyframes hp-dirz { 0% { opacity: 0; transform: scale(var(--from,.4)); } 35% { opacity: .6; } 100% { opacity: 0; transform: scale(var(--to,1.8)); } }
.hp-toast { position: absolute; left: 50%; bottom: 22px; transform: translate(-50%,16px); opacity: 0; max-width: calc(100% - 40px);
            padding: 10px 18px; border: 1px solid var(--g); background: rgba(0,18,7,.94); font: 15px var(--mono); letter-spacing: .1em;
            color: var(--g-hi); text-shadow: 0 0 8px var(--g); box-shadow: 0 0 30px rgba(0,255,102,.25); transition: opacity .25s, transform .25s; }
.hp-toast.show { opacity: 1; transform: translate(-50%,0); }
.hp-toast.warn { border-color: var(--amber); color: #ffe7b0; text-shadow: none; }
.hp-toast.err { border-color: var(--red); color: #ffd0d9; text-shadow: none; }
.hp-zoomhud { position: absolute; top: 16px; left: 50%; display: flex; align-items: center; gap: 12px; padding: 8px 16px; border: 1px solid var(--g);
              background: rgba(0,14,6,.92); transform: translate(-50%,-10px); opacity: 0; transition: opacity .2s, transform .2s;
              font: 13px var(--mono); letter-spacing: .16em; color: var(--muted); box-shadow: 0 0 30px rgba(0,255,102,.3); }
.hp-zoomhud.on { opacity: 1; transform: translate(-50%,0); }
.hp-zoomhud b { min-width: 64px; font: 900 22px var(--display); color: var(--g-hi); text-shadow: 0 0 10px var(--g); }
.hp-zoomhud i { width: 140px; height: 6px; background: var(--g-faint); } .hp-zoomhud u { display: block; height: 100%; width: 28%; background: var(--g); }
.hp-phud { display: none; position: absolute; left: 18px; bottom: 16px; gap: 14px; padding: 6px 12px; border: 1px solid var(--line);
           background: rgba(0,10,4,.8); font: 13px var(--mono); letter-spacing: .12em; color: var(--muted); opacity: .7; }
body.hp-presenting .hp-phud { display: flex; }
.hp-phud-hand { display: inline-flex; align-items: center; gap: 7px; } .hp-phud-hand i { width: 9px; height: 9px; border-radius: 50%; background: #2a4a35; }
.hp-phud-hand.on { color: var(--g); } .hp-phud-hand.on i { background: var(--g); box-shadow: 0 0 10px var(--g); }
.hp-phud-hand.locked, .hp-phud-hand.paused { color: var(--amber); } .hp-phud-hand.locked i, .hp-phud-hand.paused i { background: var(--amber); }
.hp-phud-page { color: var(--g-hi); }
.hp-laser { position: fixed; left: 0; top: 0; z-index: 9996; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; pointer-events: none;
            opacity: 0; transition: opacity .15s; background: radial-gradient(circle, #fff 0 18%, #ff2a4a 30%, rgba(255,42,74,.35) 55%, transparent 72%);
            box-shadow: 0 0 18px 6px rgba(255,42,74,.45); }
.hp-laser.on { opacity: 1; }

/* ---------- present mode: the slide fills the whole screen */
body.hp-presenting .hp-stage-wrap { position: fixed !important; inset: 0 !important; z-index: 9990; height: 100vh !important; border: 0; background: #020604 !important; }
body.hp-presenting .hp-stage { padding: 6px; }
body.hp-presenting .hp-corners { display: none; }

@media (max-width: 1200px) { .hp-home { grid-template-columns: 1fr; } .hp-side { display: none; } .hp-home-center { grid-column: 1; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
"""

_LOGO = ('<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" fill="rgba(0,255,102,.08)" '
         'stroke="#00ff66" stroke-width="3"/><path d="M24 38V22m6 16V18m6 20V19m6 19V24m-20 12c0 8 4 12 10 12s10-4 10-12" '
         'fill="none" stroke="#c8ffd9" stroke-width="3.5" stroke-linecap="round"/></svg>')

_HEX_ICONS = {
    "shield": '<path d="M32 16l12 5v10c0 9-6 14-12 17-6-3-12-8-12-17V21z"/><path d="M26 32l4 4 8-8"/>',
    "lock": '<rect x="22" y="29" width="20" height="16" rx="2"/><path d="M26 29v-5a6 6 0 0 1 12 0v5"/>',
    "hand": '<path d="M26 34V22m5 12V19m5 15V20m5 14V24"/><path d="M24 33c0 10 4 13 9 13s9-3 9-13"/>',
    "target": '<circle cx="32" cy="32" r="12"/><circle cx="32" cy="32" r="5"/><path d="M32 14v6m0 24v6M14 32h6m24 0h6"/>',
    "chip": '<rect x="23" y="23" width="18" height="18" rx="2"/><path d="M27 23v-5m5 5v-5m5 5v-5m-10 23v5m5-5v5m5-5v5M23 27h-5m5 5h-5m5 5h-5m23-10h5m-5 5h5m-5 5h5"/>',
    "network": '<circle cx="32" cy="19" r="3"/><circle cx="21" cy="42" r="3"/><circle cx="43" cy="42" r="3"/><path d="M32 22l-10 17m10-17l10 17M24 42h16"/>',
}


def _hex_svg(kind: str) -> str:
    return ('<svg viewBox="0 0 64 64" fill="none" stroke="#00ff66" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" stroke-width="3" fill="rgba(0,255,102,.06)"/>'
            f'{_HEX_ICONS[kind]}</svg>')


@lru_cache(maxsize=1)
def global_css() -> str:
    return f"<style>{_CSS}</style>"


@lru_cache(maxsize=1)
def background_html() -> str:
    rng = random.Random(42)
    cols = []
    for i in range(46):
        digits = "".join(rng.choice("01") for _ in range(rng.randint(18, 40)))
        cols.append(
            f'<span class="hp-col" style="left:{i * 100 / 46 + rng.uniform(-.6, .6):.2f}vw;'
            f'animation-duration:{rng.uniform(7, 18):.1f}s;animation-delay:-{rng.uniform(0, 18):.1f}s;'
            f'opacity:{rng.uniform(.25, .8):.2f}">{digits}</span>')
    city = "".join(f'<i style="height:{rng.uniform(12, 100):.0f}%"></i>' for _ in range(48))
    return ('<div class="hp-bg"><div class="hp-rain">' + "".join(cols) + '</div>'
            f'<div class="hp-city">{city}</div><div class="hp-floor"></div><div class="hp-vignette"></div></div>'
            '<div class="hp-scan"></div>')


@lru_cache(maxsize=1)
def globe_html(radius: int = 150) -> str:
    """A dotted Earth built from CSS-3D transformed dots (only the side facing the viewer is drawn)."""
    dots = []
    step = 4.6
    lat = -84.0
    while lat <= 84:
        n = max(1, int(360 / step * math.cos(math.radians(lat))))
        for k in range(n):
            lon = -180 + (k + 0.5) * 360 / n
            if is_land(lat, lon):
                dots.append(f'<i style="transform:rotateY({lon:.1f}deg) rotateX({lat:.1f}deg) translateZ({radius}px)"></i>')
        lat += step
    cities = [(31.5, 74.3), (51.5, -0.1), (40.7, -74.0), (35.7, 139.7), (-33.9, 151.2), (25.2, 55.3), (1.35, 103.8), (-23.5, -46.6)]
    for la, lo in cities:
        dots.append(f'<i class="c" style="transform:rotateY({lo:.1f}deg) rotateX({la:.1f}deg) translateZ({radius + 2}px)"></i>')
    rings = "".join(f'<b style="transform:rotateY({a}deg)"></b>' for a in range(0, 180, 30))
    rings += '<b style="transform:rotateX(90deg)"></b>'
    hexes = "".join(
        f'<div class="hp-hex" style="left:{x}px;top:{y}px;animation-delay:-{d}s">{_hex_svg(k)}</div>'
        for k, x, y, d in [("shield", -330, -190, 0), ("lock", 270, -170, 1.5), ("hand", -310, 60, 2.5),
                           ("target", 260, 70, 3.5), ("chip", -200, -260, 1), ("network", 150, -265, 4)])
    return ('<div class="hp-globe-zone"><div class="hp-beam"></div>'
            '<div class="hp-ripple"></div><div class="hp-ripple r2"></div><div class="hp-ripple r3"></div>'
            '<div class="hp-glow"></div>'
            '<div class="hp-orbit o1"></div><div class="hp-orbit o2"></div><div class="hp-orbit o3"></div>'
            f'<div class="hp-globe-tilt"><div class="hp-globe">{"".join(dots)}{rings}</div></div>{hexes}</div>')


def topbar_html(chip: str) -> str:
    return (f'<div class="hp-topbar"><div class="hp-brand">{_LOGO}<div><div class="hp-title" data-text="AI HAND DETECTION">'
            'AI HAND DETECTION</div><div class="hp-sub">PRESENTATION CONTROL SYSTEM</div></div></div>'
            '<div class="hp-chips"><span class="hp-chip">● LOCAL AI</span><span class="hp-chip">FREE</span>'
            '<span class="hp-chip">NO API KEYS</span><span class="hp-chip">PYTHON · STREAMLIT</span>'
            f'<span class="hp-chip mono">{chip}</span></div><span class="hp-clock">--:--:--</span></div>')
