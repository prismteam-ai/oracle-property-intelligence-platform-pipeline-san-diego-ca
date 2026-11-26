// structureMapping.js: the only structural fact in the source is QUAL_CLASS_SHAPE, whose
// first character is the framing type (A steel, B box, C masonry, D wood frame,
// M manufactured, S special). That maps to lexicon structure.primary_framing_material for
// A, C and D. The layer says nothing about roofs, walls, floors, foundations or windows, so
// every other required structure field is written as null by data_extractor.js.
'use strict';

const path = require('path');
const { FRAMING, readFeature, text, writeJson } = require('./sd_common.js');

const feature = readFeature(process.cwd());
const a = feature === null ? {} : feature.attributes;
const qualClassShape = text(a.qual_class_shape);
const framingCode = qualClassShape === null ? null : qualClassShape[0].toUpperCase();
const framing = framingCode !== null && FRAMING[framingCode] !== undefined ? FRAMING[framingCode] : null;

writeJson(path.join(process.cwd(), 'owners', 'structure_data.json'), {
  primary_framing_material: framing,
  not_mapped: {
    qual_class_shape: qualClassShape,
    framing_code_without_lexicon_value: framing === null ? framingCode : null,
  },
});
