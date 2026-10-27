// Hand-drawn 32×32 pixel companions, shared by desktop and settings previews.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DMPetSprites = api;
})(globalThis, () => {
  const palettes = {
    human: ['544355','f4cba9','ffe5c8','fff0da','eaa0a0','ce9b84'],
    cat: ['68483f','edac69','ffe1b1','fff1d6','eea6a1','cf8854'],
    dog: ['634b45','c99b73','f5dfbb','fff0d8','eaa0a0','a97b60'],
    rabbit: ['8d7e91','eee8e5','fff9ed','ffffff','eaa4b7','d3c6d0'],
    fox: ['744738','e99255','fff1d3','ffd9a2','e9a19b','c46d43'],
    goose: ['647282','e8edf0','fffaf0','ffffff','f2b45f','c8d2df'],
    cockroach: ['593f42','b27b5c','e3b588','f6d2a2','e8a4a2','8b5b4e'],
    mosquito: ['56516e','9288ae','cbd8ef','f0f2ff','d88ba6','756a92'],
    capybara: ['705147','b79270','ead2ac','f8e7c6','d9a0a0','99765f'],
    frog: ['46695d','8cc39b','e2edbd','c9e7b2','eaa5a1','6fa68a'],
    penguin: ['424c63','728197','faf2dd','a7bbcf','ecac69','59677f'],
    turtle: ['536653','91b698','dce5b2','c9d9aa','e7af9d','71927c'],
    hedgehog: ['68504c','b28e77','eed8b7','dec1a0','e8afa6','93705e'],
  };
  const color = hex => [parseInt(hex.slice(0,2),16),parseInt(hex.slice(2,4),16),parseInt(hex.slice(4,6),16),255];
  const mix = (a,b,t) => a.map((v,i) => i===3 ? v : Math.round(v+(b[i]-v)*t));
  const white = color('fff9ef'), ink = color('39364a');
  // A short blink follows the longer resting pose and small movements.
  function frameAt(time) {
    const phase = ((Number.isFinite(time) ? time : 0) % 2800 + 2800) % 2800;
    return phase < 1400 ? 0 : phase < 1960 ? 1 : phase < 2660 ? 2 : 3;
  }
  function render(animal = 'cat', mood = 'normal', frame = 0) {
    const buffer = new Uint8ClampedArray(32*32*4);
    if (!Object.hasOwn(palettes,animal)) animal='cat';
    const [Outline,Mid,Light,Highlight,Accent,Detail] = palettes[animal].map(color);
    frame = Number.isFinite(frame) ? Math.abs(Math.trunc(frame))%4 : 0;
    const bob = frame===1 ? -1 : 0;
    function pixel(x,y,c) {
      x=Math.round(x);y=Math.round(y);
      if(x>=0&&y>=0&&x<32&&y<32)buffer.set(c,(y*32+x)*4);
    }
    function rect(x,y,w,h,c) {for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)pixel(xx,yy,c);}
    function line(x,y,x2,y2,c) {
      const dx=Math.abs(x2-x),dy=-Math.abs(y2-y),sx=x<x2?1:-1,sy=y<y2?1:-1;
      let error=dx+dy;
      while(true){pixel(x,y,c);if(x===x2&&y===y2)break;const e=2*error;if(e>=dy){error+=dy;x+=sx;}if(e<=dx){error+=dx;y+=sy;}}
    }
    function shape(x,y,w,h,inside,fill,outline,shade=false) {
      const light=shade?mix(fill,white,.25):fill,dark=shade?mix(fill,Outline,.18):fill;
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++) {
        if(!inside(xx,yy))continue;
        const edge=outline&&(!inside(xx-1,yy)||!inside(xx+1,yy)||!inside(xx,yy-1)||!inside(xx,yy+1));
        pixel(x+xx,y+yy,edge?outline:shade&&xx+yy<w*.45+h*.3?light:shade&&xx+yy>w*.6+h*.65?dark:fill);
      }
    }
    function oval(x,y,w,h,fill,outline=null,shade=false) {
      const inside=(xx,yy)=>xx>=0&&yy>=0&&xx<w&&yy<h&&((xx+.5-w/2)/(w/2))**2+((yy+.5-h/2)/(h/2))**2<=1;
      shape(x,y,w,h,inside,fill,outline,shade);
    }
    function box(x,y,w,h,fill,outline=Outline) {
      const inside=(xx,yy)=>xx>=0&&yy>=0&&xx<w&&yy<h&&!((xx===0||xx===w-1)&&(yy===0||yy===h-1));
      shape(x,y,w,h,inside,fill,outline,true);
    }
    function triangle(x,y,w,h,fill,outline=Outline) {
      const inside=(xx,yy)=>yy>=0&&yy<h&&xx>=Math.floor((w-1)/2*(1-yy/(h-1)))&&xx<w-Math.floor((w-1)/2*(1-yy/(h-1)));
      shape(x,y,w,h,inside,fill,outline,true);
    }
    const puff=(x,y,w,h,fill=Mid)=>oval(x,y,w,h,fill,Outline,true);
    function eye(x,y) {
      if(mood==='sleepy'||frame===3){line(x,y+1,x+2,y+1,Outline);pixel(x+3,y,Outline);return;}
      if(mood==='happy'){pixel(x,y+1,ink);pixel(x+1,y,ink);pixel(x+2,y+1,ink);return;}
      if(mood==='bored'){rect(x,y+1,3,1,Outline);pixel(x+1,y+2,ink);return;}
      rect(x,y,2,3,ink);pixel(x,y,white);
    }
    function face(x,y,spacing=6,nose=true) {
      eye(x,y);eye(x+spacing,y);
      const blush=mix(Mid,Accent,.7),center=x+Math.floor(spacing/2);
      rect(x-2,y+3,2,1,blush);rect(x+spacing+2,y+3,2,1,blush);
      if(nose)pixel(center+1,y+3,Accent);
      pixel(center,y+4,Outline);pixel(center+2,y+4,Outline);pixel(center+1,y+5,Outline);
    }
    function feet(y=27,fill=Light,left=9,right=20) {
      box(left,y,5,3,fill);box(right,y,5,3,fill);
      pixel(left+2,y+1,Highlight);pixel(right+2,y+1,Highlight);
    }
    function cat() {
      puff(22,15+bob,7,12);puff(23,14+bob,5,6,Light);
      puff(9,18+bob,15,10);oval(12,21+bob,8,6,Light);feet(27,Light,9,19);
      triangle(6,4+bob,8,10,Mid);triangle(18,4+bob,8,10,Mid);
      triangle(8,7+bob,4,5,Accent,null);triangle(20,7+bob,4,5,Accent,null);
      puff(5,10+bob,22,14);oval(10,17+bob,12,6,Light);
      rect(14,11+bob,1,3,Detail);rect(17,11+bob,1,2,Detail);
      face(10,15+bob,9);line(5,19+bob,8,20+bob,Outline);line(24,20+bob,28,19+bob,Outline);
    }
    function dog() {
      puff(23,17+bob,6,8,Detail);puff(8,18+bob,16,11);oval(12,22+bob,8,6,Light);feet();
      puff(6,7+bob,21,17);puff(4,9+bob,6,13,Detail);puff(24,9+bob,5,13,Detail);
      oval(11,17+bob,12,6,Light);eye(11,13+bob);eye(20,13+bob);
      box(15,17+bob,4,3,Outline);line(17,20+bob,17,21+bob,Outline);
      if(frame===2&&mood!=='sleepy')box(17,21+bob,3,3,Accent,null);
      rect(11,24+bob,11,2,color('829eaf'));pixel(16,25+bob,color('efcb7f'));
    }
    function rabbit() {
      box(8,1,5,13,Mid);box(19,3+(frame===2?1:0),6,12,Mid);
      box(10,4,2,7,Accent,null);box(21,6,2,6,Accent,null);pixel(24,4,Light);
      puff(8,19+bob,17,10);puff(23,23+bob,5,5,Light);oval(12,21+bob,9,7,Light);feet();
      puff(5,10+bob,23,14);oval(10,17+bob,13,6,Light);face(10,14+bob,9);
      pixel(7,15+bob,Highlight);pixel(25,16+bob,Highlight);
    }
    function fox() {
      puff(21,14+(frame===2?1:0),9,14);puff(24,20,6,7,Light);
      puff(8,20+bob,16,9);oval(13,21+bob,8,7,Light);feet(27,Detail,9,19);
      triangle(5,3+bob,9,13,Mid);triangle(18,3+bob,9,13,Mid);
      triangle(8,6+bob,4,7,Detail,null);triangle(21,6+bob,4,7,Detail,null);
      puff(4,10+bob,24,14);oval(5,16+bob,11,7,Light);oval(16,16+bob,11,7,Light);
      eye(10,14+bob);eye(20,14+bob);rect(15,18+bob,3,2,Outline);pixel(16,21+bob,Outline);
      rect(7,18+bob,2,1,Accent);rect(24,18+bob,2,1,Accent);
    }
    function human() {
      feet(28,color('6d718a'),11,18);box(10,19+bob,13,10,color('879fc7'));
      rect(15,20+bob,3,3,white);line(16,23+bob,16,27+bob,color('627ea7'));
      puff(7,21+bob,5,5,Mid);puff(22,20+bob+(frame===2?-2:0),5,5,Mid);
      puff(6,7+bob,22,15);puff(5,13+bob,4,5);puff(25,13+bob,4,5);
      const hair=color('6b5356');puff(6,4+bob,22,10,hair);
      box(7,8+bob,5,9,hair);rect(23,10+bob,3,6,hair);line(11,11+bob,20,7+bob,hair);
      line(10,7+bob,18,5+bob,color('967379'));face(12,13+bob,7,false);
    }
    function goose() {
      feet(27,Accent,8,19);puff(5,17+bob,22,12);puff(16,10+bob,9,14,Light);
      puff(12,4+bob,15,13,Light);puff(4,18+bob,12,8,Highlight);
      line(7,22+bob,12,24+bob,Detail);line(8,20+bob,13,22+bob,Light);
      box(23,11+bob,8,4,Accent);line(27,13+bob,30,13+bob,color('c28b51'));
      eye(20,8+bob);rect(22,14+bob,2,1,color('edb5af'));pixel(16,5+bob,Highlight);
    }
    function cockroach() {
      const sway=frame===2?1:0;
      for(let i=0;i<3;i++){
        const y=17+i*4,step=(frame+i)%2;
        line(9+sway,y,5+sway,y+2-step,Outline);line(5+sway,y+2-step,4+sway,y+3-step,Detail);
        line(23+sway,y,27+sway,y+2-step,Outline);line(27+sway,y+2-step,28+sway,y+3-step,Detail);
      }
      puff(7+sway,13,19,16);puff(9+sway,15,14,12,Mid);
      line(16+sway,17,16+sway,27,Detail);line(11+sway,19,13+sway,25,Light);line(21+sway,20,20+sway,24,Highlight);
      line(12+sway,8,8+sway,3+(frame===1?1:0),Outline);line(20+sway,8,24+sway,3,Outline);
      pixel(8+sway,3+(frame===1?1:0),Highlight);pixel(24+sway,3,Highlight);
      puff(8+sway,6,18,13);face(12+sway,10,7,false);
    }
    function mosquito() {
      const lift=frame===1?2:0;
      oval(3,9-lift,12,8,[195,215,236,200],Outline);oval(19,9-lift,11,8,[195,215,236,200],Outline);
      line(6,11-lift,12,14-lift,white);line(21,14-lift,27,11-lift,white);
      puff(12,17+bob,10,10);line(14,20+bob,20,20+bob,Detail);line(14,23+bob,19,23+bob,Detail);
      for(let i=0;i<2;i++){line(13,22+i*3+bob,9,25+i*2+bob,Outline);line(21,22+i*3+bob,25,25+i*2+bob,Outline);}
      puff(8,9+bob,19,13);face(12,12+bob,7,false);line(23,18+bob,29,20+bob,Accent);
      line(13,9+bob,12,6+bob,Outline);line(21,9+bob,23,6+bob,Outline);
    }
    function capybara() {
      puff(5,16+bob,23,12);feet(27,Detail,8,20);oval(8,21+bob,13,5,Light);
      puff(10,7+bob,7,7,Detail);puff(22,7+bob,7,7,Detail);
      puff(9,10+bob,21,14);oval(17,17+bob,12,6,Light);face(13,14+bob,9);
      rect(23,18+bob,3,2,Outline);pixel(12,9+bob,Accent);pixel(24,9+bob,Accent);
    }
    function frog() {
      const hop=mood==='happy'&&frame===1?-2:bob;
      puff(8,19+hop,17,10);oval(11,21+hop,11,7,Light);
      puff(3,23+hop,8,6);puff(23,23+hop,7,6);feet(28,Highlight,5,22);
      puff(4,9+hop,25,15);puff(6,5+hop,8,10,Highlight);puff(20,5+hop,8,10,Highlight);
      eye(9,8+hop);eye(23,8+hop);rect(7,17+hop,3,1,Accent);rect(24,17+hop,3,1,Accent);
      line(12,17+hop,14,19+hop,Outline);line(14,19+hop,20,19+hop,Outline);line(20,19+hop,22,17+hop,Outline);
      pixel(15,13+hop,Detail);pixel(19,13+hop,Detail);
    }
    function penguin() {
      const sway=frame===2?1:0;
      feet(28,Accent,9+sway,19+sway);puff(6+sway,5+bob,21,24);
      oval(10+sway,13+bob,13,14,Light);oval(9+sway,11+bob,8,10,Light);oval(17+sway,11+bob,8,10,Light);
      puff(4+sway,17+bob,5,10+(frame===1?-2:0),Detail);puff(25+sway,16+bob,4,10,Detail);
      eye(11+sway,13+bob);eye(21+sway,13+bob);box(15+sway,17+bob,5,3,Accent);
      rect(10+sway,18+bob,2,1,color('e8b6af'));rect(23+sway,18+bob,2,1,color('e8b6af'));
      line(14+sway,7+bob,17+sway,6+bob,Highlight);pixel(16+sway,4+bob,Outline);
    }
    function turtle() {
      const step=frame===1?1:0;
      puff(7,24,6,5,Light);puff(19,24-step,6,5,Light);triangle(2,20,6,5,Mid);
      puff(3,10,24,17);oval(6,12,17,11,Detail);
      box(11,13,8,8,Mid);line(10,14,7,13,Highlight);line(10,19,7,22,Highlight);line(19,14,22,13,Highlight);line(19,20,22,22,Highlight);
      line(7,24,23,24,Highlight);puff(21,16+step,10,10,Light);eye(25,18+step);
      pixel(29,23+step,Outline);rect(23,23+step,2,1,Accent);
    }
    function hedgehog() {
      for(let i=0;i<6;i++)triangle(3+i*3,8+(i%2)+bob,6,11,Detail);
      puff(3,12+bob,25,16,Detail);
      for(let i=0;i<5;i++){line(6+i*4,15+(i%2)+bob,7+i*4,18+(i%2)+bob,Highlight);pixel(7+i*4,21+bob,Mid);}
      feet(27,Mid,8,21);puff(17,12+bob,5,6,Mid);puff(12,16+bob,18,11,Light);
      eye(17,18+bob);eye(25,18+bob);rect(19,23+bob,2,1,Accent);box(27,22+bob,4,3,Outline,null);
    }
    function accessory() {
      const border=color('65566b');
      if(mood==='eating') {
        box(20,25,11,5,color('d98e9b'),border);rect(21,25,9,1,color('f6c3bb'));
        oval(22,23,3,3,color('e9bc77'),border);oval(26,23,3,3,color('e9bc77'),border);pixel(24,21+(frame%2),white);
      } else if(mood==='working') {
        box(18,20,13,9,color('829bad'),border);rect(20,22,9,5,color('cce9e8'));
        rect(21,23,4,1,white);rect(21+(frame%2),25,5,1,color('8bafb4'));rect(17,29,15,2,border);rect(20,29,9,1,color('b9c6cd'));
      } else if(mood==='reading') {
        box(17,23,15,8,color('e6b883'),border);rect(19,24,5,5,white);rect(25,24,5,5,color('f5e3bb'));
        line(24,24,24,30,border);rect(20,25,3,1,color('b6a39a'));rect(26,26,3,1,color('b6a39a'));pixel(29,24+frame,color('d58a91'));
      } else if(mood==='relaxing') {
        box(22,24,7,6,color('b4cbbb'),border);oval(28,25,4,4,color('d9e4ce'),border);
        rect(23,24,5,1,color('8c7770'));line(24,22,23+(frame%2),20,color('96a9b8'));line(27,21,26+(frame%2),18,color('96a9b8'));
      } else if(mood==='exercising') {
        box(19,26,3,5,color('96b9ad'),border);box(28,26,3,5,color('96b9ad'),border);rect(22,28,6,2,border);
        oval(27,6+(frame%2),3,4,color('a5d3e5'),border);
      }
      if(mood==='sleepy') {
        const c=color('8195b6'),y=4-(frame%2);line(25,y,28,y,c);line(28,y,25,y+3,c);line(25,y+3,28,y+3,c);
      } else if(mood==='happy') {
        const c=color('dc91a2');pixel(27,3,c);pixel(29,3,c);rect(26,4,5,1,c);rect(27,5,3,1,c);pixel(28,6,c);
      }
    }
    // Keep the grounding shadow fixed while the body breathes. No opaque backdrop.
    oval(7,28,21,3,[65,60,79,28]);oval(11,29,13,2,[65,60,79,20]);
    const draws={human,cat,dog,rabbit,fox,goose,cockroach,mosquito,capybara,frog,penguin,turtle,hedgehog};
    draws[animal]();accessory();
    return buffer;
  }
  return {render,frameAt,animals:Object.keys(palettes)};
});
