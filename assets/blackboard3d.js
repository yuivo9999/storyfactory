/* =========================================================
 * 3D 黑板背景（仅 blackboard 主题加载）
 * 复用开源 three.js（r128, MIT）。教室墙 + 地板 + 窗 + Toon 卡通光影，
 * 作为固定背景层，内容卡片浮在其上。提供 start()/stop() 以便切换主题时释放。
 * ========================================================= */
(function(){
  let renderer, scene, camera, raf, container, running=false;

  function toonGradient(){
    const c = document.createElement('canvas'); c.width=4; c.height=1;
    const g = c.getContext('2d');
    [70,140,205,255].forEach((s,i)=>{ g.fillStyle=`rgb(${s},${s},${s})`; g.fillRect(i,0,1,1); });
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps=false;
    return t;
  }

  function build(){
    const host = document.getElementById('bg3d');
    if(!host) return;
    container = host;
    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = null; // 透明，露出 body 底色
    scene.fog = new THREE.Fog(0x10151c, 9, 20);

    camera = new THREE.PerspectiveCamera(46, window.innerWidth/window.innerHeight, 0.1, 100);
    camera.position.set(0, 0.3, 7.2);

    const grad = toonGradient();
    // 灯光：主光(左上暖白) + 补光(右冷蓝) + 边缘光 → 游戏化分层明暗
    scene.add(new THREE.AmbientLight(0x4a5568, 0.55));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.15); key.position.set(-5,6,5); scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fa6ff, 0.5); fill.position.set(6,1,4); scene.add(fill);
    const rim = new THREE.PointLight(0xffd27f, 0.6, 30); rim.position.set(0,3,4); scene.add(rim);

    // 墙
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(24,14),
      new THREE.MeshToonMaterial({ color:0xd9c9a3, gradientMap:grad }));
    wall.position.set(0,0,-0.8); scene.add(wall);
    // 墙裙
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(24,3.4),
      new THREE.MeshToonMaterial({ color:0xb59b6e, gradientMap:grad }));
    skirt.position.set(0,-3.0,-0.79); scene.add(skirt);
    // 窗
    const win = new THREE.Mesh(new THREE.PlaneGeometry(3.6,2.6),
      new THREE.MeshBasicMaterial({ color:0xbfe3ff }));
    win.position.set(6.2,1.4,-0.75); scene.add(win);
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(3.9,2.9,0.12),
      new THREE.MeshToonMaterial({ color:0xf2efe6, gradientMap:grad }));
    winFrame.position.set(6.2,1.4,-0.82); scene.add(winFrame);
    const winBarV = new THREE.Mesh(new THREE.BoxGeometry(0.12,2.9,0.14),
      new THREE.MeshToonMaterial({ color:0xf2efe6, gradientMap:grad }));
    winBarV.position.set(6.2,1.4,-0.7); scene.add(winBarV);
    // 地板
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24,12),
      new THREE.MeshToonMaterial({ color:0x8a6f4a, gradientMap:grad }));
    floor.rotation.x = -Math.PI/2; floor.position.set(0,-4.7,-0.8); scene.add(floor);

    // 两块装饰黑板（固定在背景，营造教室感，不参与内容）
    function decoBoard(x){
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(4.6,3.1,0.18),
        new THREE.MeshToonMaterial({ color:0x6e4a2b, gradientMap:grad }));
      g.add(frame);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(4.3,2.8),
        new THREE.MeshToonMaterial({ color:0x13352a, gradientMap:grad }));
      face.position.z = 0.11; g.add(face);
      g.position.set(x, 0.6, -0.6);
      scene.add(g);
    }
    decoBoard(-6.4); decoBoard(6.4);
  }

  function animate(){
    if(!running) return;
    raf = requestAnimationFrame(animate);
    const t = performance.now()*0.0002;
    camera.position.x = Math.sin(t)*0.5;
    camera.position.y = 0.3 + Math.sin(t*1.3)*0.12;
    camera.lookAt(0, 0.2, 0);
    renderer.render(scene, camera);
  }

  window.Blackboard3D = {
    start(){
      if(running) return;
      if(!renderer) build();
      if(!renderer) return;
      running = true; animate();
    },
    stop(){
      running = false;
      if(raf) cancelAnimationFrame(raf);
      if(renderer && container){ renderer.dispose(); container.innerHTML=''; renderer=null; }
    }
  };
})();
