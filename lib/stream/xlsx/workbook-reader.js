/**
 * Copyright (c) 2015-2017 Guyon Roche
 * LICENCE: MIT - please refer to LICENCE file included with this module
 * or https://github.com/guyonroche/exceljs/blob/master/LICENSE
 */

'use strict';

var fs = require('fs');
var events = require('events');
var Stream = require('stream');
var unzip = require('unzip2');
var Sax = require('sax');

var utils = require('../../utils/utils');
var FlowControl = require('../../utils/flow-control');

var StyleManager = require('../../xlsx/xform/style/styles-xform');

var WorksheetReader = require('./worksheet-reader');
var HyperlinkReader = require('./hyperlink-reader');

var WorkbookReader = module.exports = function(options) {
  this.options = options = options || {};

  // until we actually parse a styles.xml file, just assume we're not handling styles
  // (but we do need to handle dates)
  this.styles = new StyleManager.Mock();

  // worksheet readers, indexed by sheetNo
  this.worksheetReaders = {};

  // hyperlink readers, indexed by sheetNo
  this.hyperlinkReaders = {};

  // count the open readers
  this.readers = 0;

  // end of stream check
  this.atEnd = false;
};

utils.inherits(WorkbookReader, events.EventEmitter, {
  _getStream: function(input) {
    if (input instanceof Stream.Readable) {
      return input;
    }
    if (typeof input === 'string') {
      return fs.createReadStream(input);
    }
    throw new Error('Could not recognise input');
  },

  get flowControl() {
    if (!this._flowControl) {
      this._flowControl = new FlowControl(this.options);
    }
    return this._flowControl;
  },

  options: {
    entries: ['emit'],
    sharedStrings: ['cache', 'emit'],
    styles: ['cache'],
    hyperlinks: ['cache', 'emit'],
    worksheets: ['emit']
  },
  read: function(input, options) {
    var self = this;
    var stream = this.stream = this._getStream(input);
    var zip = this.zip = unzip.Parse();

    zip.on('entry', function(entry) {
      var match, sheetNo;
      switch (entry.path) {
        case '_rels/.rels':
        case 'xl/workbook.xml':
        case 'xl/_rels/workbook.xml.rels':
          entry.autodrain();
          break;
        case 'xl/sharedStrings.xml':
          self._parseSharedStrings(entry, options);
          break;
        case 'xl/styles.xml':
          self._parseStyles(entry, options);
          break;
        default:
          if (entry.path.match(/xl\/worksheets\/sheet\d+[.]xml/)) {
            match = entry.path.match(/xl\/worksheets\/sheet(\d+)[.]xml/);
            sheetNo = match[1];
            self._parseWorksheet(entry, sheetNo, options);
          } else if (entry.path.match(/xl\/worksheets\/_rels\/sheet\d+[.]xml.rels/)) {
            match = entry.path.match(/xl\/worksheets\/_rels\/sheet(\d+)[.]xml.rels/);
            sheetNo = match[1];
            self._parseHyperlinks(entry, sheetNo, options);
          } else {
            entry.autodrain();
          }
          break;
      }
    });

    zip.on('close', function() {
      self.emit('end');
      self.atEnd = true;
      if (!self.readers) {
        self.emit('finished');
      }
    });

    // Pipe stream into top flow-control
    // this.flowControl.pipe(zip);
    stream.pipe(zip);
  },
  _emitEntry: function(options, payload) {
    if (options.entries === 'emit') {
      this.emit('entry', payload);
    }
  },
  _parseSharedStrings: function(entry, options) {
    this._emitEntry(options, {type: 'shared-strings'});
    var self = this;
    var sharedStrings = null;
    switch (options.sharedStrings) {
      case 'cache':
        sharedStrings = this.sharedStrings = [];
        break;
      case 'emit':
        break;
      default:
        entry.autodrain();
        return;
    }

    var parser = Sax.createStream(true, {});
    var inT = false;
    var t = null;
    var index = 0;
    parser.on('opentag', function(node) {
      if (node.name === 't') {
        t = null;
        inT = true;
      }
    });
    parser.on('closetag', function(name) {
      if (inT && (name === 't')) {
        if (sharedStrings) {
          sharedStrings.push(t);
        } else {
          self.emit('shared-string', { index: index++, text: t});
        }
        t = null;
      }
    });
    parser.on('text', function(text) {
      t = t ? t + text : text;
    });
    parser.on('error', function(error) {
      self.emit('error', error);
    });
    entry.pipe(parser);
  },
  _parseStyles: function(entry, options) {
    this._emitEntry(options, {type: 'styles'});
    if (options.styles !== 'cache') {
      entry.autodrain();
      return;
    }
    this.styles = new StyleManager();
    this.styles.parse(entry);
  },
  _getReader: function(Type, collection, sheetNo) {
    var self = this;
    var reader = collection[sheetNo];
    if (!reader) {
      reader = new Type(this, sheetNo);
      self.readers++;
      reader.on('finished', function() {
        if (!--self.readers) {
          if (self.atEnd) {
            self.emit('finished');
          }
        }
      });
      collection[sheetNo] = reader;
    }
    return reader;
  },
  _parseWorksheet: function(entry, sheetNo, options) {
    this._emitEntry(options, {type: 'worksheet', id: sheetNo});
    var worksheetReader = this._getReader(WorksheetReader, this.worksheetReaders, sheetNo);
    if (options.worksheets === 'emit') {
      this.emit('worksheet', worksheetReader);
    }
    worksheetReader.read(entry, options, this.hyperlinkReaders[sheetNo]);
  },
  _parseHyperlinks: function(entry, sheetNo, options) {
    this._emitEntry(options, {type: 'hyerlinks', id: sheetNo});
    var hyperlinksReader = this._getReader(HyperlinkReader, this.hyperlinkReaders, sheetNo);
    if (options.hyperlinks === 'emit') {
      this.emit('hyperlinks', hyperlinksReader);
    }
    hyperlinksReader.read(entry, options);
  }
});
