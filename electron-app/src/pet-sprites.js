// Ported from archive/legacy-dotnet/Services/PixelPetRenderer.cs.
// Original 32×32 sprites, palettes and four-frame animation; RGBA output works in Canvas and Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DMPetSprites = api;
})(globalThis, () => {
  const palettes = {
    cat: {
      Outline: C(0xFF, 0x78, 0x45, 0x24),
      Mid: C(0xFF, 0xF4, 0xA4, 0x60),
      Light: C(0xFF, 0xF9, 0xD2, 0xA0),
      Highlight: C(0xFF, 0xFF, 0xE8, 0xC7),
      Accent: C(0xFF, 0xFF, 0xB6, 0xC1),
      Detail: C(0xFF, 0xD6, 0x78, 0x33),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x6A, 0x42, 0x30),
      Collar: C(0xFF, 0x9B, 0x60, 0x36),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    dog: {
      Outline: C(0xFF, 0x67, 0x49, 0x2B),
      Mid: C(0xFF, 0xD2, 0xA6, 0x79),
      Light: C(0xFF, 0xE9, 0xCC, 0xA3),
      Highlight: C(0xFF, 0xF6, 0xE3, 0xC9),
      Accent: C(0xFF, 0xFF, 0x73, 0x96),
      Detail: C(0xFF, 0xB6, 0x86, 0x58),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x2E, 0x20, 0x18),
      Collar: C(0xFF, 0xCC, 0x3B, 0x3B),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    rabbit: {
      Outline: C(0xFF, 0xB8, 0xB8, 0xB8),
      Mid: C(0xFF, 0xF5, 0xF5, 0xF5),
      Light: C(0xFF, 0xFF, 0xFF, 0xFF),
      Highlight: C(0xFF, 0xFF, 0xFF, 0xFF),
      Accent: C(0xFF, 0xFF, 0xCB, 0xDC),
      Detail: C(0xFF, 0xE7, 0xE7, 0xE7),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0xF8, 0x9C, 0xAE),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    fox: {
      Outline: C(0xFF, 0xA0, 0x42, 0x10),
      Mid: C(0xFF, 0xE8, 0x6B, 0x2A),
      Light: C(0xFF, 0xFF, 0xED, 0xDE),
      Highlight: C(0xFF, 0xFF, 0xD2, 0xA1),
      Accent: C(0xFF, 0xFF, 0xC6, 0x85),
      Detail: C(0xFF, 0xD6, 0x5F, 0x21),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x2E, 0x20, 0x18),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    goose: {
      Outline: C(0xFF, 0x6F, 0x7C, 0x89),
      Mid: C(0xFF, 0xF5, 0xF7, 0xFA),
      Light: C(0xFF, 0xFF, 0xFF, 0xFF),
      Highlight: C(0xFF, 0xE4, 0xEC, 0xF4),
      Accent: C(0xFF, 0xF0, 0x9C, 0x33),
      Detail: C(0xFF, 0xD9, 0x7F, 0x1D),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0xD9, 0x7F, 0x1D),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    cockroach: {
      Outline: C(0xFF, 0x43, 0x24, 0x17),
      Mid: C(0xFF, 0x78, 0x46, 0x29),
      Light: C(0xFF, 0x9A, 0x63, 0x3C),
      Highlight: C(0xFF, 0xB2, 0x7C, 0x4D),
      Accent: C(0xFF, 0xA0, 0x6E, 0x3F),
      Detail: C(0xFF, 0x5D, 0x33, 0x20),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x43, 0x24, 0x17),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    mosquito: {
      Outline: C(0xFF, 0x37, 0x3A, 0x47),
      Mid: C(0xFF, 0x58, 0x5C, 0x72),
      Light: C(0x66, 0xE8, 0xF2, 0xFF),
      Highlight: C(0xFF, 0x8A, 0x8F, 0xA8),
      Accent: C(0xFF, 0xD7, 0x4F, 0x66),
      Detail: C(0xFF, 0x4A, 0x4F, 0x63),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x37, 0x3A, 0x47),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    capybara: {
      Outline: C(0xFF, 0x67, 0x48, 0x2E),
      Mid: C(0xFF, 0xA7, 0x78, 0x4E),
      Light: C(0xFF, 0xC4, 0x98, 0x6C),
      Highlight: C(0xFF, 0xD7, 0xB1, 0x8D),
      Accent: C(0xFF, 0x6C, 0x51, 0x44),
      Detail: C(0xFF, 0x8A, 0x60, 0x3A),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x5A, 0x3C, 0x2A),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    frog: {
      Outline: C(0xFF, 0x3C, 0x6D, 0x26),
      Mid: C(0xFF, 0x72, 0xB7, 0x45),
      Light: C(0xFF, 0xA9, 0xD9, 0x72),
      Highlight: C(0xFF, 0xD8, 0xF1, 0xA8),
      Accent: C(0xFF, 0xF0, 0xC1, 0x8A),
      Detail: C(0xFF, 0x4E, 0x8A, 0x30),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x6B, 0x9D, 0x3A),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    penguin: {
      Outline: C(0xFF, 0x2D, 0x37, 0x49),
      Mid: C(0xFF, 0x43, 0x4F, 0x66),
      Light: C(0xFF, 0xF6, 0xF8, 0xFB),
      Highlight: C(0xFF, 0xD9, 0xE1, 0xEF),
      Accent: C(0xFF, 0xF0, 0xA8, 0x2F),
      Detail: C(0xFF, 0x1F, 0x26, 0x33),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0xF0, 0xA8, 0x2F),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    turtle: {
      Outline: C(0xFF, 0x4F, 0x57, 0x2A),
      Mid: C(0xFF, 0x6F, 0x87, 0x3A),
      Light: C(0xFF, 0xA6, 0xBF, 0x7A),
      Highlight: C(0xFF, 0xB1, 0x6E, 0x41),
      Accent: C(0xFF, 0xC8, 0xD8, 0x94),
      Detail: C(0xFF, 0x7D, 0x4F, 0x2D),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x4F, 0x57, 0x2A),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    hedgehog: {
      Outline: C(0xFF, 0x5A, 0x45, 0x35),
      Mid: C(0xFF, 0x8E, 0x6D, 0x52),
      Light: C(0xFF, 0xD8, 0xBE, 0x9F),
      Highlight: C(0xFF, 0xB3, 0x8A, 0x67),
      Accent: C(0xFF, 0x9E, 0x76, 0x57),
      Detail: C(0xFF, 0x6C, 0x54, 0x41),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0x3A, 0x2D, 0x25),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0x00, 0x00, 0x00, 0x00),
      Hair: C(0x00, 0x00, 0x00, 0x00),
      Clothes: C(0x00, 0x00, 0x00, 0x00),
      Pants: C(0x00, 0x00, 0x00, 0x00),
    },
    human: {
      Outline: C(0xFF, 0x6C, 0x51, 0x44),
      Mid: C(0xFF, 0xFF, 0xE0, 0xBD),
      Light: C(0xFF, 0xFF, 0xED, 0xD2),
      Highlight: C(0xFF, 0x9B, 0xB5, 0xFF),
      Accent: C(0xFF, 0xE5, 0x8A, 0x8A),
      Detail: C(0xFF, 0x4A, 0x55, 0x68),
      Eye: C(0xFF, 0x20, 0x20, 0x20),
      Nose: C(0xFF, 0xB7, 0x7E, 0x6A),
      Collar: C(0x00, 0x00, 0x00, 0x00),
      Skin: C(0xFF, 0xFF, 0xE0, 0xBD),
      Hair: C(0xFF, 0x3A, 0x33, 0x28),
      Clothes: C(0xFF, 0x6C, 0x8B, 0xE8),
      Pants: C(0xFF, 0x4A, 0x55, 0x68),
    },
  };
  function C(a, r, g, b) { return [a, r, g, b]; }
  function render(animal = "cat", mood = "normal", frame = 0) {
    const buffer = new Uint8ClampedArray(32 * 32 * 4);
    const palette = palettes[animal] || palettes.cat;
    frame = Math.abs(Math.trunc(frame)) % 4;
    function SetPixel(x, y, color) {
      x = Math.trunc(x); y = Math.trunc(y);
      if (x < 0 || y < 0 || x >= 32 || y >= 32 || !color[0]) return;
      const index = (y * 32 + x) * 4;
      buffer.set([color[1], color[2], color[3], color[0]], index);
    }
    function DrawShadow(color)
    {
        let shadowShift = frame % 2 == 0 ? 0 : 1;
        FillEllipse(8, 26 + shadowShift, 16, 4, color);
    }

    function DrawCat(p)
    {
        let bob = mood == "happy" && frame % 2 == 1 ? -1 : 0;
        let tailY = frame % 2 == 0 ? 11 : 13;
        FillTail(23, tailY + bob, frame % 2 == 0 ? 4 : 2, 8, p.Mid, p.Outline);

        FillEllipse(7, 14 + bob, 16, 10, p.Mid);
        StrokeEllipse(7, 14 + bob, 16, 10, p.Outline);
        FillEllipse(10, 8 + bob, 10, 9, p.Mid);
        StrokeEllipse(10, 8 + bob, 10, 9, p.Outline);

        FillTriangleUp(11, 8 + bob, 3, 4, p.Mid);
        FillTriangleUp(17, 8 + bob, 3, 4, p.Mid);
        StrokeTriangleUp(11, 8 + bob, 3, 4, p.Outline);
        StrokeTriangleUp(17, 8 + bob, 3, 4, p.Outline);
        FillTriangleUp(12, 10 + bob, 1, 2, p.Accent);
        FillTriangleUp(18, 10 + bob, 1, 2, p.Accent);

        FillEllipse(11, 17 + bob, 3, 2, p.Light);
        FillEllipse(16, 17 + bob, 3, 2, p.Light);
        DrawFace(13, 12 + bob, 4, p, "Cat");
        DrawBodyHighlights(10, 17 + bob, 10, 5, p);
        DrawPaws(10, 22 + bob, p.Outline, p.Light);
        DrawCatStripes(9, 14 + bob, p.Detail);
    }

    function DrawDog(p)
    {
        let bob = mood == "happy" && frame % 2 == 1 ? -1 : 0;
        let tailY = frame % 2 == 0 ? 15 : 11;
        FillTail(23, tailY + bob, frame % 2 == 0 ? 5 : 3, 7, p.Detail, p.Outline);

        FillEllipse(7, 15 + bob, 16, 10, p.Mid);
        StrokeEllipse(7, 15 + bob, 16, 10, p.Outline);
        FillEllipse(9, 8 + bob, 12, 10, p.Mid);
        StrokeEllipse(9, 8 + bob, 12, 10, p.Outline);

        FillRoundedRect(7, 10 + bob, 4, 7, p.Detail);
        FillRoundedRect(19, 10 + bob, 4, 7, p.Detail);
        StrokeRoundedRect(7, 10 + bob, 4, 7, p.Outline);
        StrokeRoundedRect(19, 10 + bob, 4, 7, p.Outline);

        FillEllipse(11, 17 + bob, 8, 5, p.Light);
        DrawFace(13, 12 + bob, 4, p, "Dog");
        FillRect(12, 16 + bob, 4, 2, p.Nose);
        if (frame == 2 && mood != "sleepy")
        {
            FillRect(13, 18 + bob, 2, 3, p.Accent);
        }
        DrawPaws(10, 23 + bob, p.Outline, p.Light);
        FillRect(10, 14 + bob, 2, 1, p.Highlight);
        FillRect(18, 14 + bob, 2, 1, p.Highlight);
        FillRect(12, 20 + bob, 6, 1, p.Collar);
    }

    function DrawRabbit(p)
    {
        let bob = frame % 2 == 0 ? 0 : -1;
        let earShift = frame % 3 == 0 ? 0 : 1;

        FillRoundedRect(10, 2 + bob, 4, 11 - earShift, p.Mid);
        FillRoundedRect(17, 2 + bob + earShift, 4, 11 - earShift, p.Mid);
        StrokeRoundedRect(10, 2 + bob, 4, 11 - earShift, p.Outline);
        StrokeRoundedRect(17, 2 + bob + earShift, 4, 11 - earShift, p.Outline);
        FillRoundedRect(11, 4 + bob, 2, 7 - earShift, p.Accent);
        FillRoundedRect(18, 4 + bob + earShift, 2, 7 - earShift, p.Accent);

        FillEllipse(9, 10 + bob, 14, 10, p.Mid);
        StrokeEllipse(9, 10 + bob, 14, 10, p.Outline);
        FillEllipse(8, 16 + bob, 16, 9, p.Mid);
        StrokeEllipse(8, 16 + bob, 16, 9, p.Outline);
        FillEllipse(12, 18 + bob, 8, 4, p.Light);

        DrawFace(13, 13 + bob, 4, p, "Rabbit");
        DrawPaws(10, 23 + bob, p.Outline, p.Light);
        FillEllipse(21, 19 + bob, 3, 3, p.Light);
        StrokeEllipse(21, 19 + bob, 3, 3, p.Outline);
    }

    function DrawFox(p)
    {
        let bob = mood == "happy" && frame % 2 == 1 ? -1 : 0;
        let tailY = frame % 2 == 0 ? 12 : 14;
        FillTail(22, tailY + bob, frame % 2 == 0 ? 6 : 3, 9, p.Mid, p.Outline);
        FillRect(26, tailY + 6 + bob, 3, 2, p.Light);

        FillEllipse(8, 15 + bob, 15, 9, p.Mid);
        StrokeEllipse(8, 15 + bob, 15, 9, p.Outline);
        FillEllipse(10, 8 + bob, 11, 9, p.Mid);
        StrokeEllipse(10, 8 + bob, 11, 9, p.Outline);

        FillTriangleUp(11, 7 + bob, 3, 4, p.Mid);
        FillTriangleUp(18, 7 + bob, 3, 4, p.Mid);
        StrokeTriangleUp(11, 7 + bob, 3, 4, p.Outline);
        StrokeTriangleUp(18, 7 + bob, 3, 4, p.Outline);

        FillTriangleDown(13, 15 + bob, 5, 4, p.Light);
        StrokeTriangleDown(13, 15 + bob, 5, 4, p.Outline);
        DrawFace(13, 11 + bob, 4, p, "Fox");
        DrawPaws(10, 23 + bob, p.Outline, p.Light);
    }

    function DrawHuman(p)
    {
        let bob = frame % 2 == 0 ? 0 : -1;
        FillEllipse(10, 7 + bob, 12, 11, p.Skin);
        StrokeEllipse(10, 7 + bob, 12, 11, p.Outline);
        FillRect(9, 7 + bob, 14, 4, p.Hair);
        FillRect(10, 10 + bob, 2, 3, p.Hair);
        FillRect(20, 10 + bob, 2, 3, p.Hair);

        DrawFace(13, 11 + bob, 4, p, "Human");
        FillRoundedRect(10, 18 + bob, 12, 8, p.Clothes);
        StrokeRoundedRect(10, 18 + bob, 12, 8, p.Outline);
        FillRect(9, 19 + bob, frame % 3 == 0 ? 4 : 2, 5, p.Skin);
        FillRect(21, 19 + bob, frame % 3 == 0 ? 2 : 4, 5, p.Skin);
        FillRect(12, 26 + bob, 3, 4, p.Pants);
        FillRect(17, 26 + bob, 3, 4, p.Pants);
        FillRect(12, 30 + bob, 3, 1, p.Outline);
        FillRect(17, 30 + bob, 3, 1, p.Outline);
        FillRect(13, 20 + bob, 6, 1, p.Highlight);
    }

    function DrawGoose(p)
    {
        let bob = frame % 2 == 0 ? 0 : -1;
        let neckLean = frame == 1 ? 2 : frame == 2 ? -1 : 0;
        let wingLift = frame == 3 ? -2 : 0;

        FillEllipse(8, 17 + bob, 16, 9, p.Mid);
        StrokeEllipse(8, 17 + bob, 16, 9, p.Outline);
        FillRoundedRect(15 + neckLean, 8 + bob, 4, 10, p.Mid);
        StrokeRoundedRect(15 + neckLean, 8 + bob, 4, 10, p.Outline);
        FillEllipse(13 + neckLean, 5 + bob, 8, 7, p.Mid);
        StrokeEllipse(13 + neckLean, 5 + bob, 8, 7, p.Outline);
        FillEllipse(9, 15 + bob + wingLift, 7, 5, p.Highlight);
        StrokeEllipse(9, 15 + bob + wingLift, 7, 5, p.Outline);
        FillRect(20 + neckLean, 8 + bob, 5, 2, p.Accent);
        FillRect(24 + neckLean, 8 + bob, 1, 1, p.Detail);
        FillEllipse(11, 19 + bob, 7, 4, p.Light);
        FillRect(10, 24 + bob, 2, 5, p.Accent);
        FillRect(19, 24 + bob, 2, 5, p.Accent);
        FillRect(9, 29 + bob, 4, 1, p.Outline);
        FillRect(18, 29 + bob, 4, 1, p.Outline);
        DrawFace(15 + neckLean, 7 + bob, 2, p, "Goose");
    }

    function DrawCockroach(p)
    {
        let scuttle = frame == 0 ? 0 : frame == 1 ? 2 : frame == 2 ? 1 : -1;
        let lean = frame == 3 ? -1 : 0;

        FillEllipse(10 + scuttle, 8 + lean, 12, 17, p.Mid);
        StrokeEllipse(10 + scuttle, 8 + lean, 12, 17, p.Outline);
        FillEllipse(11 + scuttle, 10 + lean, 10, 7, p.Detail);
        FillRect(15 + scuttle, 10, 1, 13, p.Highlight);
        FillEllipse(12 + scuttle, 23, 8, 4, p.Light);

        DrawAntenna(13 + scuttle, 8 + lean, -3, frame % 2 == 0 ? -4 : -5, p.Outline);
        DrawAntenna(19 + scuttle, 8 + lean, 3, frame % 2 == 0 ? -4 : -5, p.Outline);
        DrawInsectLegs(10 + scuttle, 14 + lean, p.Outline);
        DrawFace(14 + scuttle, 12 + lean, 3, p, "Cockroach");
    }

    function DrawMosquito(p)
    {
        let bob = frame % 2 == 0 ? 0 : -1;
        let wingLift = frame == 0 ? 0 : frame == 1 ? -3 : frame == 2 ? -1 : -4;
        let proboscisShift = frame == 2 ? 1 : 0;

        FillEllipse(13, 13 + bob, 6, 11, p.Mid);
        StrokeEllipse(13, 13 + bob, 6, 11, p.Outline);
        FillEllipse(12, 9 + bob, 8, 6, p.Detail);
        StrokeEllipse(12, 9 + bob, 8, 6, p.Outline);
        FillEllipse(8, 9 + bob + wingLift, 7, 4, p.Light);
        FillEllipse(17, 9 + bob + wingLift, 7, 4, p.Light);
        StrokeEllipse(8, 9 + bob + wingLift, 7, 4, p.Outline);
        StrokeEllipse(17, 9 + bob + wingLift, 7, 4, p.Outline);
        FillRect(15, 24 + bob, 1, 5, p.Outline);
        DrawProboscis(16 + proboscisShift, 11 + bob, p.Accent);
        DrawMosquitoLegs(13, 18 + bob, p.Outline);
        DrawFace(13, 10 + bob, 4, p, "Mosquito");
    }

    function DrawCapybara(p)
    {
        let bob = mood == "happy" && frame % 2 == 1 ? -1 : 0;
        let headShift = frame == 1 ? 1 : frame == 3 ? -1 : 0;
        FillEllipse(7, 14 + bob, 17, 10, p.Mid);
        StrokeEllipse(7, 14 + bob, 17, 10, p.Outline);
        FillEllipse(13 + headShift, 9 + bob, 10, 8, p.Mid);
        StrokeEllipse(13 + headShift, 9 + bob, 10, 8, p.Outline);
        FillRoundedRect(13 + headShift, 8 + bob, 3, 3, p.Detail);
        FillRoundedRect(19 + headShift, 8 + bob, 3, 3, p.Detail);
        StrokeRoundedRect(13 + headShift, 8 + bob, 3, 3, p.Outline);
        StrokeRoundedRect(19 + headShift, 8 + bob, 3, 3, p.Outline);
        FillEllipse(11, 18 + bob, 9, 4, p.Light);
        FillRect(8, 23 + bob, 3, 4, p.Detail);
        FillRect(18, 23 + bob, 3, 4, p.Detail);
        FillRect(8, 27 + bob, 3, 1, p.Outline);
        FillRect(18, 27 + bob, 3, 1, p.Outline);
        DrawFace(15 + headShift, 12 + bob, 3, p, "Capybara");
    }

    function DrawFrog(p)
    {
        let hop = frame == 1 ? -2 : 0;
        FillEllipse(8, 15 + hop, 16, 10, p.Mid);
        StrokeEllipse(8, 15 + hop, 16, 10, p.Outline);
        FillEllipse(10, 10 + hop, 12, 8, p.Mid);
        StrokeEllipse(10, 10 + hop, 12, 8, p.Outline);
        FillEllipse(10, 7 + hop, 4, 4, p.Highlight);
        FillEllipse(18, 7 + hop, 4, 4, p.Highlight);
        StrokeEllipse(10, 7 + hop, 4, 4, p.Outline);
        StrokeEllipse(18, 7 + hop, 4, 4, p.Outline);
        DrawFace(12, 11 + hop, 6, p, "Frog");
        FillRect(9, 23 + hop, 3, 4, p.Detail);
        FillRect(20, 23 + hop, 3, 4, p.Detail);
        FillRect(7, 24 + hop, 2, 2, p.Highlight);
        FillRect(23, 24 + hop, 2, 2, p.Highlight);
    }

    function DrawPenguin(p)
    {
        let sway = frame == 1 ? 1 : frame == 3 ? -1 : 0;
        FillEllipse(9 + sway, 10, 14, 17, p.Mid);
        StrokeEllipse(9 + sway, 10, 14, 17, p.Outline);
        FillEllipse(12 + sway, 14, 8, 10, p.Light);
        FillEllipse(11 + sway, 6, 10, 8, p.Detail);
        StrokeEllipse(11 + sway, 6, 10, 8, p.Outline);
        DrawFace(13 + sway, 10, 4, p, "Penguin");
        FillTriangleDown(20 + sway, 11, 4, 3, p.Accent);
        FillRect(8 + sway, 16, 2, 7, p.Detail);
        FillRect(22 + sway, 16, 2, 7, p.Detail);
        FillRect(12 + sway, 27, 3, 2, p.Accent);
        FillRect(17 + sway, 27, 3, 2, p.Accent);
    }

    function DrawTurtle(p)
    {
        let headOut = frame == 1 || frame == 2 ? 2 : 0;
        FillEllipse(8, 15, 16, 10, p.Mid);
        StrokeEllipse(8, 15, 16, 10, p.Outline);
        FillEllipse(10, 17, 12, 6, p.Detail);
        FillEllipse(21, 17, 5 + headOut, 4, p.Light);
        StrokeEllipse(21, 17, 5 + headOut, 4, p.Outline);
        FillEllipse(7, 17, 3, 3, p.Light);
        FillEllipse(10, 23, 4, 3, p.Light);
        FillEllipse(18, 23, 4, 3, p.Light);
        DrawFace(22, 18, 1, p, "Turtle");
        FillRect(13, 19, 6, 1, p.Highlight);
        FillRect(12, 21, 8, 1, p.Highlight);
    }

    function DrawHedgehog(p)
    {
        let curl = frame == 2 ? -1 : 0;
        FillEllipse(8, 13 + curl, 16, 11, p.Detail);
        StrokeEllipse(8, 13 + curl, 16, 11, p.Outline);
        for (let i = 0; i < 6; i++)
            FillTriangleUp(8 + i * 3, 10 + (i % 2 == 0 ? 0 : 1) + curl, 3, 4, p.Highlight);
        FillEllipse(13, 16 + curl, 11, 7, p.Light);
        StrokeEllipse(13, 16 + curl, 11, 7, p.Outline);
        DrawFace(16, 17 + curl, 3, p, "Hedgehog");
        FillRect(11, 23 + curl, 2, 3, p.Accent);
        FillRect(19, 23 + curl, 2, 3, p.Accent);
    }

    function DrawFace(x, y, spacing, p, kind)
    {
        switch (mood)
        {
            case "sleepy":
                FillRect(x, y, 2, 1, p.Outline);
                FillRect(x + spacing, y, 2, 1, p.Outline);
                break;
            case "happy":
                FillRect(x, y, 2, 1, p.Outline);
                FillRect(x + spacing, y, 2, 1, p.Outline);
                FillRect(x + 1, y + 3, 4, 1, p.Accent);
                break;
            case "bored":
                FillRect(x, y, 2, 1, p.Outline);
                FillRect(x + spacing, y, 2, 1, p.Outline);
                FillRect(x + 1, y + 3, 4, 1, p.Detail);
                break;
            default:
                FillRect(x, y, 2, 2, p.Eye);
                FillRect(x + spacing, y, 2, 2, p.Eye);
                FillRect(x + 1, y + 3, 3, 1, p.Accent);
                break;
        }

        if (mood == "happy" && ["Cat", "Rabbit", "Human"].includes(kind))
        {
            FillRect(x - 1, y + 2, 1, 1, p.Accent);
            FillRect(x + spacing + 2, y + 2, 1, 1, p.Accent);
        }
    }

    function DrawBodyHighlights(x, y, width, height, p)
    {
        FillRect(x + 1, y + 1, width - 2, Math.trunc(height / 2), p.Light);
        FillRect(x + 2, y + 2, width - 5, 1, p.Highlight);
    }

    function DrawPaws(x, y, outline, fill)
    {
        FillRoundedRect(x, y, 4, 3, fill);
        FillRoundedRect(x + 8, y, 4, 3, fill);
        StrokeRoundedRect(x, y, 4, 3, outline);
        StrokeRoundedRect(x + 8, y, 4, 3, outline);
    }

    function DrawCatStripes(x, y, stripe)
    {
        FillRect(x + 2, y + 2, 2, 1, stripe);
        FillRect(x + 7, y + 1, 2, 1, stripe);
        FillRect(x + 4, y + 5, 2, 1, stripe);
    }

    function DrawSleepBubble()
    {
        let shift = frame % 2;
        FillRect(22, 4 - shift, 2, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
        FillRect(24, 2 - shift, 3, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
        FillRect(24, 3 - shift, 1, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
        FillRect(26, 1 - shift, 2, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
    }

    function DrawLifeStateAccessory(p)
    {
        switch (mood)
        {
            case "eating":
                DrawFoodBowl(p);
                break;
            case "working":
                DrawLaptop(p);
                break;
            case "reading":
                DrawBook(p);
                break;
            case "exercising":
                DrawExerciseMarks(p);
                break;
            case "relaxing":
                DrawRelaxCup(p);
                break;
        }
    }

    function DrawFoodBowl(p)
    {
        FillEllipse(20, 24, 9, 4, C(0xFF, 0xE8, 0x6A, 0x6A));
        StrokeEllipse(20, 24, 9, 4, p.Outline);
        FillRect(22, 23, 2, 1, C(0xFF, 0xFF, 0xD1, 0x66));
        FillRect(25, 23, 2, 1, C(0xFF, 0xFF, 0xD1, 0x66));
        FillRect(24, 22 + (frame % 2), 1, 1, C(0xFF, 0xFF, 0xF2, 0xB0));
    }

    function DrawLaptop(p)
    {
        FillRoundedRect(18, 20, 11, 7, C(0xFF, 0x38, 0x4A, 0x5E));
        StrokeRoundedRect(18, 20, 11, 7, p.Outline);
        FillRect(20, 22, 7, 3, C(0xFF, 0x9B, 0xD8, 0xFF));
        FillRect(17, 27, 13, 2, C(0xFF, 0x5B, 0x67, 0x78));
        FillRect(21 + (frame % 3), 23, 2, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
    }

    function DrawBook(p)
    {
        FillRoundedRect(18, 22, 6, 6, C(0xFF, 0xFF, 0xF1, 0xB8));
        FillRoundedRect(24, 22, 6, 6, C(0xFF, 0xFF, 0xE5, 0x8A));
        StrokeRoundedRect(18, 22, 12, 6, p.Outline);
        FillRect(24, 22, 1, 6, p.Outline);
        FillRect(20, 24, 3, 1, C(0xFF, 0xA0, 0x79, 0x3A));
        FillRect(26, 24, 2 + (frame % 2), 1, C(0xFF, 0xA0, 0x79, 0x3A));
    }

    function DrawExerciseMarks(p)
    {
        let sweat = C(0xFF, 0x6E, 0xD6, 0xFF);
        FillEllipse(23, 5 + (frame % 2), 2, 3, sweat);
        StrokeEllipse(23, 5 + (frame % 2), 2, 3, p.Outline);
        FillRect(24, 23, 6, 2, C(0xFF, 0x72, 0xE0, 0x98));
        FillRect(22, 22, 2, 4, C(0xFF, 0x72, 0xE0, 0x98));
        FillRect(30, 22, 2, 4, C(0xFF, 0x72, 0xE0, 0x98));
        SetPixel(26, 8, C(0xFF, 0xFF, 0xF0, 0x6A));
        SetPixel(27, 7, C(0xFF, 0xFF, 0xF0, 0x6A));
        SetPixel(28, 8, C(0xFF, 0xFF, 0xF0, 0x6A));
    }

    function DrawRelaxCup(p)
    {
        FillRoundedRect(21, 23, 7, 5, C(0xFF, 0xD7, 0xF8, 0xD7));
        StrokeRoundedRect(21, 23, 7, 5, p.Outline);
        StrokeEllipse(27, 24, 3, 3, p.Outline);
        FillRect(22, 22, 5, 1, C(0xFF, 0x87, 0xC7, 0x8A));
        let steam = frame % 2;
        SetPixel(23, 19 - steam, C(0xCC, 0xFF, 0xFF, 0xFF));
        SetPixel(25, 18 + steam, C(0xCC, 0xFF, 0xFF, 0xFF));
        SetPixel(27, 19 - steam, C(0xCC, 0xFF, 0xFF, 0xFF));
    }

    function FillRect(x, y, width, height, color)
    {
        for (let py = y; py < y + height; py++)
            for (let px = x; px < x + width; px++)
                SetPixel(px, py, color);
    }

    function FillRoundedRect(x, y, width, height, color)
    {
        for (let py = 0; py < height; py++)
        {
            for (let px = 0; px < width; px++)
            {
                let corner = (px == 0 || px == width - 1) && (py == 0 || py == height - 1);
                if (!corner)
                    SetPixel(x + px, y + py, color);
            }
        }
    }

    function StrokeRoundedRect(x, y, width, height, color)
    {
        for (let px = 1; px < width - 1; px++)
        {
            SetPixel(x + px, y, color);
            SetPixel(x + px, y + height - 1, color);
        }

        for (let py = 1; py < height - 1; py++)
        {
            SetPixel(x, y + py, color);
            SetPixel(x + width - 1, y + py, color);
        }
    }

    function FillEllipse(x, y, width, height, color)
    {
        let rx = width / 2.0;
        let ry = height / 2.0;
        let cx = x + rx;
        let cy = y + ry;

        for (let py = y; py < y + height; py++)
        {
            for (let px = x; px < x + width; px++)
            {
                let dx = (px + 0.5 - cx) / rx;
                let dy = (py + 0.5 - cy) / ry;
                if (dx * dx + dy * dy <= 1.0)
                    SetPixel(px, py, color);
            }
        }
    }

    function StrokeEllipse(x, y, width, height, color)
    {
        let rx = width / 2.0;
        let ry = height / 2.0;
        let cx = x + rx;
        let cy = y + ry;

        for (let py = y; py < y + height; py++)
        {
            for (let px = x; px < x + width; px++)
            {
                let dx = (px + 0.5 - cx) / rx;
                let dy = (py + 0.5 - cy) / ry;
                let d = dx * dx + dy * dy;
                if (d <= 1.08 && d >= 0.7)
                    SetPixel(px, py, color);
            }
        }
    }

    function FillTriangleUp(x, y, width, height, color)
    {
        for (let row = 0; row < height; row++)
        {
            let w = Math.max(1, width - row);
            let offset = Math.trunc(row / 2);
            FillRect(x + offset, y + row, w, 1, color);
        }
    }

    function StrokeTriangleUp(x, y, width, height, color)
    {
        for (let row = 0; row < height; row++)
        {
            let w = Math.max(1, width - row);
            let offset = Math.trunc(row / 2);
            SetPixel(x + offset, y + row, color);
            SetPixel(x + offset + w - 1, y + row, color);
        }
    }

    function FillTriangleDown(x, y, width, height, color)
    {
        for (let row = 0; row < height; row++)
        {
            let w = Math.max(1, width - row);
            let offset = Math.trunc(row / 2);
            FillRect(x + offset, y + row, w, 1, color);
        }
    }

    function StrokeTriangleDown(x, y, width, height, color)
    {
        for (let row = 0; row < height; row++)
        {
            let w = Math.max(1, width - row);
            let offset = Math.trunc(row / 2);
            SetPixel(x + offset, y + row, color);
            SetPixel(x + offset + w - 1, y + row, color);
        }
    }

    function FillTail(x, y, width, height, fill, outline)
    {
        FillRoundedRect(x, y, width, height, fill);
        StrokeRoundedRect(x, y, width, height, outline);
    }

    function DrawAntenna(x, y, dx, dy, color)
    {
        for (let i = 0; i < 4; i++)
            SetPixel(x + Math.trunc(dx * i / 3), y + Math.trunc(dy * i / 3), color);
    }

    function DrawInsectLegs(x, y, color)
    {
        for (let i = 0; i < 3; i++)
        {
            SetPixel(x - 1, y + i * 3, color);
            SetPixel(x - 2, y + i * 3 + 1, color);
            SetPixel(x + 12, y + i * 3, color);
            SetPixel(x + 13, y + i * 3 + 1, color);
        }
    }

    function DrawProboscis(x, y, color)
    {
        SetPixel(x + 4, y + 1, color);
        SetPixel(x + 5, y + 1, color);
        SetPixel(x + 6, y + 1, color);
    }

    function DrawMosquitoLegs(x, y, color)
    {
        SetPixel(x - 2, y + 1, color);
        SetPixel(x - 3, y + 2, color);
        SetPixel(x + 8, y + 1, color);
        SetPixel(x + 9, y + 2, color);
        SetPixel(x - 1, y + 4, color);
        SetPixel(x - 2, y + 5, color);
        SetPixel(x + 7, y + 4, color);
        SetPixel(x + 8, y + 5, color);
    }


    DrawShadow(C(0x80, 0, 0, 0));
    const draws = {cat: DrawCat, dog: DrawDog, rabbit: DrawRabbit, fox: DrawFox,
      human: DrawHuman, goose: DrawGoose, cockroach: DrawCockroach, mosquito: DrawMosquito,
      capybara: DrawCapybara, frog: DrawFrog, penguin: DrawPenguin, turtle: DrawTurtle, hedgehog: DrawHedgehog};
    (draws[animal] || DrawCat)(palette);
    DrawLifeStateAccessory(palette);
    if (mood === "sleepy") DrawSleepBubble();
    return buffer;
  }
  return { render, animals: Object.keys(palettes) };
});
