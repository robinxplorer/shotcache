// Synthetic-frame verification for Stitcher/StitchAccumulator (longshot.cs).
// Builds a tall image with unique random rows, cuts it into overlapping
// frames with a fixed header/footer band (simulating sticky chrome inside the
// selection) at uneven scroll steps, stitches them back, and pixel-compares
// the result. Compiled and run by test-host.ps1 alongside the protocol test;
// NOT part of shotcache-host.exe.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using Shotcache;

static class StitchTest
{
    static int Main()
    {
        int W = 700, H = 600, HDR = 40, FTR = 30;
        int CONT = H - HDR - FTR;
        int SRC_H = 4000;
        Random rnd = new Random(42);

        Bitmap src = new Bitmap(W, SRC_H, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(src))
        {
            for (int y = 0; y < SRC_H; y++)
            {
                using (Pen p = new Pen(Color.FromArgb(255, rnd.Next(256), rnd.Next(256), rnd.Next(256))))
                    g.DrawLine(p, 0, y, W, y);
            }
        }

        List<int> offsets = new List<int>();
        offsets.Add(0);
        int yo = 0;
        while (yo < SRC_H - CONT)
        {
            yo = Math.Min(yo + 150 + rnd.Next(150), SRC_H - CONT);
            offsets.Add(yo);
        }

        StitchAccumulator acc = null;
        for (int i = 0; i < offsets.Count; i++)
        {
            Bitmap f = MakeFrame(src, W, H, HDR, FTR, CONT, offsets[i]);
            if (acc == null)
            {
                acc = new StitchAccumulator(f);
                continue;
            }
            int want = offsets[i] - offsets[i - 1];
            int got = acc.Add(f);
            if (got != want)
            {
                Console.WriteLine("FAIL shift at frame " + i + ": got " + got + " want " + want);
                return 1;
            }
        }
        for (int k = 0; k < 3; k++)
        {
            int got = acc.Add(MakeFrame(src, W, H, HDR, FTR, CONT, offsets[offsets.Count - 1]));
            if (got != 0)
            {
                Console.WriteLine("FAIL no-change pass " + k + ": got " + got);
                return 1;
            }
        }
        if (acc.NoChangeStreak != 3)
        {
            Console.WriteLine("FAIL streak=" + acc.NoChangeStreak);
            return 1;
        }

        int lastY = offsets[offsets.Count - 1];
        int wantH = HDR + lastY + CONT + FTR;
        using (Bitmap outBmp = acc.Compose())
        {
            if (outBmp.Width != W || outBmp.Height != wantH)
            {
                Console.WriteLine("FAIL size " + outBmp.Width + "x" + outBmp.Height + " want " + W + "x" + wantH);
                return 1;
            }
            for (int k = 0; k < 600; k++)
            {
                int x = rnd.Next(W);
                int y = rnd.Next(lastY + CONT);
                if (outBmp.GetPixel(x, HDR + y).ToArgb() != src.GetPixel(x, y).ToArgb())
                {
                    Console.WriteLine("FAIL pixel at " + x + "," + y);
                    return 1;
                }
            }
            if (outBmp.GetPixel(10, HDR / 2).ToArgb() != Color.FromArgb(255, 230, 120, 20).ToArgb())
            {
                Console.WriteLine("FAIL header band");
                return 1;
            }
            if (outBmp.GetPixel(10, wantH - FTR / 2).ToArgb() != Color.FromArgb(255, 60, 60, 70).ToArgb())
            {
                Console.WriteLine("FAIL footer band");
                return 1;
            }
        }
        acc.Dispose();
        Console.WriteLine("STITCH PASS: frames=" + offsets.Count + " height=" + wantH);
        return 0;
    }

    static Bitmap MakeFrame(Bitmap src, int W, int H, int HDR, int FTR, int CONT, int yOff)
    {
        Bitmap f = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(f))
        {
            using (SolidBrush hb = new SolidBrush(Color.FromArgb(255, 230, 120, 20)))
                g.FillRectangle(hb, 0, 0, W, HDR);
            g.DrawImage(src, new Rectangle(0, HDR, W, CONT),
                new Rectangle(0, yOff, W, CONT), GraphicsUnit.Pixel);
            using (SolidBrush fb = new SolidBrush(Color.FromArgb(255, 60, 60, 70)))
                g.FillRectangle(fb, 0, H - FTR, W, FTR);
        }
        return f;
    }
}
