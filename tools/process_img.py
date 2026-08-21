#!/usr/bin/env python3
"""
素材图批处理：改尺寸 / 压缩 / jpg<->png / 去透明
用法：
  python3 process_img.py <输入图> <输出基础名> \
      [--size 1080x1920] [--jpg] [--no-alpha] [--quality 85] [--maxkb 200] \
      [--outdir /workspace/assets/img/skins]

示例（把用户发来的山水图处理成国风背景）：
  python3 process_img.py ~/uploads/xxx.png guofeng-shanshui \
      --size 1080x1920 --maxkb 200
示例（把手柄图转透明 PNG）：
  python3 process_img.py ~/uploads/pad.jpg cyber-gamepad --maxkb 120
示例（把透明图去透明变白底 JPG）：
  python3 process_img.py ~/uploads/seal.png gudai-wood --jpg --no-alpha --maxkb 150
"""
import argparse, os
from PIL import Image

def fit_crop(im, tw, th):
    """按比例裁剪并缩放到目标尺寸（居中裁切，不变形）"""
    w, h = im.size
    src, tgt = w / h, tw / th
    if src > tgt:                       # 原图太宽，裁左右
        nw = int(h * tgt); x = (w - nw) // 2
        im = im.crop((x, 0, x + nw, h))
    else:                               # 原图太高，裁上下
        nh = int(w / tgt); y = (h - nh) // 2
        im = im.crop((0, y, w, y + nh))
    return im.resize((tw, th), Image.LANCZOS)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', help='输入图片路径')
    ap.add_argument('name', help='输出基础名，如 guofeng-shanshui')
    ap.add_argument('--size', default=None, help='目标尺寸 WxH，如 1080x1920')
    ap.add_argument('--jpg', action='store_true', help='强制输出 JPG')
    ap.add_argument('--no-alpha', action='store_true', help='去透明→白底不透明')
    ap.add_argument('--quality', type=int, default=85, help='JPG 初始质量')
    ap.add_argument('--maxkb', type=int, default=200, help='单图大小上限 KB')
    ap.add_argument('--outdir', default='/workspace/assets/img/skins')
    a = ap.parse_args()

    im = Image.open(a.src).convert('RGBA')

    if a.size:
        tw, th = map(int, a.size.split('x'))
        im = fit_crop(im, tw, th)

    if a.no_alpha:
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im).convert('RGB')

    os.makedirs(a.outdir, exist_ok=True)

    if a.jpg or (a.no_alpha and im.mode == 'RGB'):
        out = os.path.join(a.outdir, f"{a.name}.jpg")
        save_im = im.convert('RGB')
        q = a.quality
        while True:
            save_im.save(out, 'JPEG', quality=q, optimize=True)
            if os.path.getsize(out) / 1024 <= a.maxkb or q <= 30:
                break
            q -= 5
        print(f"✅ JPG 输出: {out}  尺寸:{Image.open(out).size}  "
              f"大小:{round(os.path.getsize(out)/1024,1)}KB  质量:{q}")
    else:
        out = os.path.join(a.outdir, f"{a.name}.png")
        im.save(out, 'PNG', optimize=True)
        kb = round(os.path.getsize(out) / 1024, 1)
        flag = '⚠️ 超过上限' if kb > a.maxkb else '✅'
        print(f"{flag} PNG 输出: {out}  尺寸:{Image.open(out).size}  大小:{kb}KB")

if __name__ == '__main__':
    main()
