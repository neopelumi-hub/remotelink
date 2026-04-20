// =============================================
// RemoteLink - Shared Utilities
// =============================================

function generateId(length = 9) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    if (i > 0 && i % 3 === 0) id += '-';
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

module.exports = { generateId, formatBytes };
