"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashFile = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const bufferSize = 1024;
const buffer = Buffer.alloc(bufferSize);
function hashFile(filePath) {
    const sha = crypto_1.createHash("sha256");
    const fileDescriptor = fs_1.openSync(filePath, "r");
    const size = fs_1.statSync(filePath).size;
    let totalBytesRead = 0;
    while (totalBytesRead < size) {
        const bytesRead = fs_1.readSync(fileDescriptor, buffer, 0, Math.min(size - totalBytesRead, bufferSize), totalBytesRead);
        if (bytesRead < bufferSize) {
            sha.update(buffer.slice(0, bytesRead));
        }
        else {
            sha.update(buffer);
        }
        totalBytesRead += bytesRead;
    }
    fs_1.closeSync(fileDescriptor);
    return sha.digest("hex");
}
exports.hashFile = hashFile;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGFzaC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9oYXNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQkFBNEQ7QUFFNUQsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFBO0FBRXZCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUE7QUFFdkMsU0FBZ0IsUUFBUSxDQUFDLFFBQWdCO0lBQ3ZDLE1BQU0sR0FBRyxHQUFHLG1CQUFVLENBQUMsUUFBUSxDQUFDLENBQUE7SUFDaEMsTUFBTSxjQUFjLEdBQUcsYUFBUSxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQTtJQUM5QyxNQUFNLElBQUksR0FBRyxhQUFRLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFBO0lBQ3BDLElBQUksY0FBYyxHQUFHLENBQUMsQ0FBQTtJQUN0QixPQUFPLGNBQWMsR0FBRyxJQUFJLEVBQUU7UUFDNUIsTUFBTSxTQUFTLEdBQUcsYUFBUSxDQUN4QixjQUFjLEVBQ2QsTUFBTSxFQUNOLENBQUMsRUFDRCxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksR0FBRyxjQUFjLEVBQUUsVUFBVSxDQUFDLEVBQzNDLGNBQWMsQ0FDZixDQUFBO1FBQ0QsSUFBSSxTQUFTLEdBQUcsVUFBVSxFQUFFO1lBQzFCLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQTtTQUN2QzthQUFNO1lBQ0wsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQTtTQUNuQjtRQUNELGNBQWMsSUFBSSxTQUFTLENBQUE7S0FDNUI7SUFDRCxjQUFTLENBQUMsY0FBYyxDQUFDLENBQUE7SUFDekIsT0FBTyxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFBO0FBQzFCLENBQUM7QUF0QkQsNEJBc0JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJjcnlwdG9cIlxuaW1wb3J0IHsgb3BlblN5bmMsIHJlYWRTeW5jLCBjbG9zZVN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcImZzXCJcblxuY29uc3QgYnVmZmVyU2l6ZSA9IDEwMjRcblxuY29uc3QgYnVmZmVyID0gQnVmZmVyLmFsbG9jKGJ1ZmZlclNpemUpXG5cbmV4cG9ydCBmdW5jdGlvbiBoYXNoRmlsZShmaWxlUGF0aDogc3RyaW5nKSB7XG4gIGNvbnN0IHNoYSA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIilcbiAgY29uc3QgZmlsZURlc2NyaXB0b3IgPSBvcGVuU3luYyhmaWxlUGF0aCwgXCJyXCIpXG4gIGNvbnN0IHNpemUgPSBzdGF0U3luYyhmaWxlUGF0aCkuc2l6ZVxuICBsZXQgdG90YWxCeXRlc1JlYWQgPSAwXG4gIHdoaWxlICh0b3RhbEJ5dGVzUmVhZCA8IHNpemUpIHtcbiAgICBjb25zdCBieXRlc1JlYWQgPSByZWFkU3luYyhcbiAgICAgIGZpbGVEZXNjcmlwdG9yLFxuICAgICAgYnVmZmVyLFxuICAgICAgMCxcbiAgICAgIE1hdGgubWluKHNpemUgLSB0b3RhbEJ5dGVzUmVhZCwgYnVmZmVyU2l6ZSksXG4gICAgICB0b3RhbEJ5dGVzUmVhZCxcbiAgICApXG4gICAgaWYgKGJ5dGVzUmVhZCA8IGJ1ZmZlclNpemUpIHtcbiAgICAgIHNoYS51cGRhdGUoYnVmZmVyLnNsaWNlKDAsIGJ5dGVzUmVhZCkpXG4gICAgfSBlbHNlIHtcbiAgICAgIHNoYS51cGRhdGUoYnVmZmVyKVxuICAgIH1cbiAgICB0b3RhbEJ5dGVzUmVhZCArPSBieXRlc1JlYWRcbiAgfVxuICBjbG9zZVN5bmMoZmlsZURlc2NyaXB0b3IpXG4gIHJldHVybiBzaGEuZGlnZXN0KFwiaGV4XCIpXG59XG4iXX0=