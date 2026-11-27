// ownerMapping.js: the public SANDAG / SanGIS Parcels layer publishes no owner name and no
// mailing address (only OWNEROCC, a Y-or-blank flag, and FRACTINT, a fractional-interest
// code). There is nothing to map to the lexicon person / company classes, so this script
// records that fact for data_extractor.js and writes no owner.
'use strict';

const path = require('path');
const { readFeature, text, writeJson } = require('./sd_common.js');

const feature = readFeature(process.cwd());
const a = feature === null ? {} : feature.attributes;

writeJson(path.join(process.cwd(), 'owners', 'owner_data.json'), {
  owners: [],
  reason: 'source layer has no owner name or mailing address fields',
  not_mapped: {
    ownerocc: text(a.ownerocc),
    fractint: a.fractint === undefined ? null : a.fractint,
  },
});
