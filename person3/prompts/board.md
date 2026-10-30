# Outfit board prompt

Create a flat, catalogue-style outfit board from the supplied garment product images.

- Use only the product images in the catalogue. Do not show a person, face, model, or mannequin
  body unless the input image already contains one.
- Arrange the garments in layer order: base, mid, outer, bottom, shoes, accessory.
- Keep each garment's shape, colour, material, and texture recognisable.
- Connect the layers with a thin vertical spine and short connectors so the board reads as one
  outfit rather than a random grid.
- Use a warm neutral background, consistent padding, and clean labels:
  layer, brand, title, price.
- No text from the model, no watermark, no invented garment details.
- The deterministic Pillow renderer implements this layout; this prompt documents the visual
  contract and can be reused if an image-generation step is added later.
