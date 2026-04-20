// =============================================
// RemoteLink - File Transfer Manager
// Core transfer engine running in the main process
// =============================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const CHUNK_SIZE = 512 * 1024; // 512KB

class FileTransferManager {
  constructor() {
    this.outgoing = new Map(); // transferId -> outgoing state
    this.incoming = new Map(); // transferId -> incoming state
  }

  /**
   * Scan a file or directory and return metadata for transfer.
   */
  async scanPath(filePath) {
    const stat = await fs.promises.stat(filePath);
    const baseName = path.basename(filePath);

    if (stat.isFile()) {
      return {
        name: baseName,
        type: 'file',
        files: [{ relativePath: baseName, absolutePath: filePath, size: stat.size }],
        emptyDirs: [],
        totalSize: stat.size,
      };
    }

    // Directory: recursively walk
    const files = [];
    const emptyDirs = [];
    let totalSize = 0;

    const walk = async (dirPath, relativeBase) => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      let hasChildren = false;

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          hasChildren = true;
          await walk(fullPath, relativePath);
        } else if (entry.isFile()) {
          hasChildren = true;
          const fileStat = await fs.promises.stat(fullPath);
          files.push({ relativePath, absolutePath: fullPath, size: fileStat.size });
          totalSize += fileStat.size;
        }
      }

      if (!hasChildren && relativeBase) {
        emptyDirs.push(relativeBase);
      }
    };

    await walk(filePath, '');

    // Wrap everything under the directory name
    return {
      name: baseName,
      type: 'folder',
      files: files.map(f => ({
        relativePath: `${baseName}/${f.relativePath}`,
        absolutePath: f.absolutePath,
        size: f.size,
      })),
      emptyDirs: emptyDirs.map(d => `${baseName}/${d}`),
      totalSize,
    };
  }

  /**
   * Start sending files for an outgoing transfer.
   */
  async startSending(transferId, socket, onProgress) {
    const transfer = this.outgoing.get(transferId);
    if (!transfer) return;

    transfer.status = 'sending';
    const { files } = transfer;

    for (let i = 0; i < files.length; i++) {
      if (transfer.status === 'cancelled') return;

      const file = files[i];
      socket.emit('transfer:file-start', {
        transferId,
        relativePath: file.relativePath,
        fileSize: file.size,
        fileIndex: i,
        totalFiles: files.length,
      });

      const fileHandle = await fs.promises.open(file.absolutePath, 'r');
      try {
        const buffer = Buffer.alloc(CHUNK_SIZE);
        let offset = 0;
        let chunkIndex = 0;

        while (offset < file.size) {
          if (transfer.status === 'cancelled') {
            await fileHandle.close();
            return;
          }

          const bytesToRead = Math.min(CHUNK_SIZE, file.size - offset);
          const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);

          socket.emit('transfer:chunk', {
            transferId,
            relativePath: file.relativePath,
            chunkIndex,
            data: Buffer.from(buffer.buffer, buffer.byteOffset, bytesRead),
            offset,
          });

          offset += bytesRead;
          chunkIndex++;
          transfer.bytesSent = (transfer.bytesSent || 0) + bytesRead;

          if (onProgress) {
            onProgress({
              transferId,
              bytesSent: transfer.bytesSent,
              totalSize: transfer.totalSize,
              currentFile: file.relativePath,
              fileIndex: i,
              totalFiles: files.length,
            });
          }

          // Yield to event loop
          await new Promise(resolve => setImmediate(resolve));
        }
      } finally {
        await fileHandle.close();
      }

      socket.emit('transfer:file-end', {
        transferId,
        relativePath: file.relativePath,
        fileIndex: i,
      });
    }

    // Send empty directories
    if (transfer.emptyDirs && transfer.emptyDirs.length > 0) {
      socket.emit('transfer:empty-dirs', {
        transferId,
        dirs: transfer.emptyDirs,
      });
    }

    socket.emit('transfer:complete', { transferId });
    transfer.status = 'complete';
  }

  /**
   * Handle incoming file-start event.
   */
  handleFileStart(transferId, data) {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    const destPath = path.join(transfer.savePath, data.relativePath);
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    transfer.currentFile = data.relativePath;
    transfer.currentStream = fs.createWriteStream(destPath);
    transfer.currentFileSize = data.fileSize;
  }

  /**
   * Handle incoming chunk event.
   */
  handleChunk(transferId, data) {
    const transfer = this.incoming.get(transferId);
    if (!transfer || !transfer.currentStream) return;

    // data.data is a Buffer
    transfer.currentStream.write(data.data);
    transfer.bytesReceived = (transfer.bytesReceived || 0) + data.data.length;
  }

  /**
   * Handle incoming file-end event.
   */
  handleFileEnd(transferId, data) {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    if (transfer.currentStream) {
      transfer.currentStream.end();
      transfer.currentStream = null;
    }
    transfer.filesReceived = (transfer.filesReceived || 0) + 1;
    transfer.currentFile = null;
  }

  /**
   * Handle incoming empty-dirs event.
   */
  handleEmptyDirs(transferId, data) {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    if (data.dirs && Array.isArray(data.dirs)) {
      for (const dir of data.dirs) {
        const dirPath = path.join(transfer.savePath, dir);
        fs.mkdirSync(dirPath, { recursive: true });
      }
    }
  }

  /**
   * Handle incoming transfer-complete event.
   */
  handleComplete(transferId) {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    if (transfer.currentStream) {
      transfer.currentStream.end();
      transfer.currentStream = null;
    }
    transfer.status = 'complete';
  }

  /**
   * Cancel an outgoing or incoming transfer.
   */
  cancelTransfer(transferId, socket) {
    const outgoing = this.outgoing.get(transferId);
    if (outgoing) {
      outgoing.status = 'cancelled';
    }

    const incoming = this.incoming.get(transferId);
    if (incoming) {
      if (incoming.currentStream) {
        incoming.currentStream.end();
        incoming.currentStream = null;
      }
      incoming.status = 'cancelled';
    }

    if (socket && socket.connected) {
      socket.emit('transfer:cancel', { transferId });
    }
  }

  /**
   * Handle remote cancel from the other peer.
   */
  handleRemoteCancel(transferId) {
    const outgoing = this.outgoing.get(transferId);
    if (outgoing) {
      outgoing.status = 'cancelled';
    }

    const incoming = this.incoming.get(transferId);
    if (incoming) {
      if (incoming.currentStream) {
        incoming.currentStream.end();
        incoming.currentStream = null;
      }
      incoming.status = 'cancelled';
    }
  }

  /**
   * Get the downloads path, creating it if needed.
   */
  getDownloadsPath() {
    const downloadsPath = path.join(os.homedir(), 'Desktop', 'RemoteLink Downloads');
    if (!fs.existsSync(downloadsPath)) {
      fs.mkdirSync(downloadsPath, { recursive: true });
    }
    return downloadsPath;
  }
}

module.exports = { FileTransferManager };
