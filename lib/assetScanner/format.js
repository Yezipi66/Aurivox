// 文件大小的人类可读格式。

function formatSize(bytes) {
 if (bytes < 1024) return bytes + "B";
 if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + "KB";
 return (bytes / (1024 * 1024)).toFixed(0) + "MB";
}

module.exports = { formatSize };
