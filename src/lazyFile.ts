// adapted from https://github.com/emscripten-core/emscripten/blob/cbc974264e0b0b3f0ce8020fb2f1861376c66545/src/library_fs.js
// flexible chunk size parameter
// Creates a file record for lazy-loading from a URL. XXX This requires a synchronous
// XHR, which is not possible in browsers except in a web worker! Use preloading,
// either --preload-file in emcc or FS.createPreloadedFile

export type RangeMapper = (
  fromByte: number,
  toByte: number
) => { url: string; fromByte: number; toByte: number };

export type LazyFileConfig = {
  rangeMapper: RangeMapper;
  /** must be known beforehand if there's multiple server chunks (i.e. rangeMapper returns different urls) */
  fileLength?: number;
  requestChunkSize: number;
};
export type PageReadLog = {
  pageno: number;
  // if page was already loaded
  wasCached: boolean;
  // how many pages were prefetched
  prefetch: number;
};

// Lazy chunked Uint8Array (implements get and length from Uint8Array). Actual getting is abstracted away for eventual reuse.
export class LazyUint8Array {
  serverChecked = false;
  chunks: Uint8Array[] = []; // Loaded chunks. Index is the chunk number
  totalFetchedBytes = 0;
  totalRequests = 0;
  readPages: PageReadLog[] = [];
  _length?: number;

  lastChunk = 0;
  speed = 1;
  _chunkSize: number;
  rangeMapper: RangeMapper;
  maxSpeed: number;

  constructor(config: LazyFileConfig) {
    this._chunkSize = config.requestChunkSize;
    this.maxSpeed = (5 * 1024 * 1024) / this._chunkSize; // max 5MiB at once
    this.rangeMapper = config.rangeMapper;
    if (config.fileLength) {
      this._length = config.fileLength;
    }
  }
  get(idx: number) {
    if (idx > this.length - 1 || idx < 0) {
      return undefined;
    }
    var chunkOffset = idx % this.chunkSize;
    var chunkNum = (idx / this.chunkSize) | 0;
    return this.getter(chunkNum)[chunkOffset];
  }
  lastGet = -1;
  getter(wantedChunkNum: number) {
    let wasCached = true;
    if (typeof this.chunks[wantedChunkNum] === "undefined") {
      wasCached = false;
      // double the fetching chunk size if the wanted chunk would be within the next fetch request
      const wouldStartChunkNum = this.lastChunk + 1;
      let fetchStartChunkNum;
      if (
        wantedChunkNum >= wouldStartChunkNum &&
        wantedChunkNum < wouldStartChunkNum + this.speed * 2
      ) {
        fetchStartChunkNum = wouldStartChunkNum;
        this.speed = Math.min(this.maxSpeed, this.speed * 2);
      } else {
        fetchStartChunkNum = wantedChunkNum;
        this.speed = 1;
      }
      const chunksToFetch = this.speed;
      const startByte = fetchStartChunkNum * this.chunkSize;
      let endByte = (fetchStartChunkNum + chunksToFetch) * this.chunkSize - 1; // including this byte
      endByte = Math.min(endByte, this.length - 1); // if datalength-1 is selected, this is the last block

      this.lastChunk = fetchStartChunkNum + chunksToFetch - 1;
      const buf = this.doXHR(startByte, endByte);
      for (let i = 0; i < chunksToFetch; i++) {
        const curChunk = fetchStartChunkNum + i;
        if (i * this.chunkSize >= buf.byteLength) break; // past end of file
        const curSize =
          (i + i) * this.chunkSize > buf.byteLength
            ? buf.byteLength - i * this.chunkSize
            : this.chunkSize;
        // console.log("constructing chunk", buf.byteLength, i * this.chunkSize, curSize);
        this.chunks[curChunk] = new Uint8Array(
          buf,
          i * this.chunkSize,
          curSize
        );
      }
    }
    if (typeof this.chunks[wantedChunkNum] === "undefined")
      throw new Error("doXHR failed (bug)!");
    const boring = this.lastGet == wantedChunkNum;
    if (!boring) {
      this.lastGet = wantedChunkNum;
      this.readPages.push({
        pageno: wantedChunkNum,
        wasCached,
        prefetch: wasCached ? 0 : this.speed - 1,
      });
    }
    return this.chunks[wantedChunkNum];
  }
  checkServer() {
    // Find length
    var xhr = new XMLHttpRequest();
    const url = this.rangeMapper(0, 0).url;
    xhr.open("HEAD", url, false);
    xhr.send(null);
    if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
      throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
    var datalength = Number(xhr.getResponseHeader("Content-length"));

    var hasByteServing = xhr.getResponseHeader("Accept-Ranges") === "bytes";
    var usesGzip = xhr.getResponseHeader("Content-Encoding") === "gzip";

    if (!hasByteServing) {
      const msg = "server does not support byte serving (`Accept-Ranges: bytes` header missing), or your database is hosted on CORS and the server d";
      console.error(msg, "seen response headers", xhr.getAllResponseHeaders());
      // throw Error(msg);
    }

    if (usesGzip || !datalength) {
      console.error("response headers", xhr.getAllResponseHeaders());
      throw Error("server uses gzip or doesn't have length");
    }

    if (!this._length) this._length = datalength;
    this.serverChecked = true;
  }
  get length() {
    if (!this.serverChecked) {
      this.checkServer();
    }
    return this._length!;
  }

  get chunkSize() {
    if (!this.serverChecked) {
      this.checkServer();
    }
    return this._chunkSize!;
  }
  private doXHR(absoluteFrom: number, absoluteTo: number) {
    console.log(
      `- [xhr of size ${(absoluteTo + 1 - absoluteFrom) / 1024} KiB]`
    );
    this.totalFetchedBytes += absoluteTo - absoluteFrom;
    this.totalRequests++;
    if (absoluteFrom > absoluteTo)
      throw new Error(
        "invalid range (" +
          absoluteFrom +
          ", " +
          absoluteTo +
          ") or no bytes requested!"
      );
    if (absoluteTo > this.length - 1)
      throw new Error(
        "only " + this.length + " bytes available! programmer error!"
      );
    const { fromByte: from, toByte: to, url } = this.rangeMapper(
      absoluteFrom,
      absoluteTo
    );

    // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    if (this.length !== this.chunkSize)
      xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);

    // Some hints to the browser that we want binary data.
    xhr.responseType = "arraybuffer";
    if (xhr.overrideMimeType) {
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
    }

    xhr.send(null);
    if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
      throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
    if (xhr.response !== undefined) {
      return xhr.response as ArrayBuffer;
    } else {
      throw Error("xhr did not return uint8array");
    }
  }
}
export function createLazyFile(
  FS: any,
  parent: string,
  name: string,
  canRead: boolean,
  canWrite: boolean,
  lazyFileConfig: LazyFileConfig
) {
  var lazyArray = new LazyUint8Array(lazyFileConfig);
  var properties = { isDevice: false, contents: lazyArray };

  var node = FS.createFile(parent, name, properties, canRead, canWrite);
  node.contents = lazyArray;
  // Add a function that defers querying the file size until it is asked the first time.
  Object.defineProperties(node, {
    usedBytes: {
      get: /** @this {FSNode} */ function () {
        return this.contents.length;
      },
    },
  });
  // override each stream op with one that tries to force load the lazy file first
  var stream_ops: any = {};
  var keys = Object.keys(node.stream_ops);
  keys.forEach(function (key) {
    var fn = node.stream_ops[key];
    stream_ops[key] = function forceLoadLazyFile() {
      FS.forceLoadFile(node);
      return fn.apply(null, arguments);
    };
  });
  // use a custom read function
  stream_ops.read = function stream_ops_read(
    stream: { node: { contents: LazyUint8Array } },
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) {
    FS.forceLoadFile(node);
    console.log(
      `[fs: ${length / 1024} KiB read request offset @ ${position / 1024} KiB `
    );
    const contents = stream.node.contents;
    if (position >= contents.length) return 0;
    const size = Math.min(contents.length - position, length);

    // TODO: optimize this to copy whole chunks at once
    for (let i = 0; i < size; i++) {
      // LazyUint8Array from sync binary XHR
      buffer[offset + i] = contents.get(position + i)!;
    }
    return size;
  };
  node.stream_ops = stream_ops;
  return node;
}
