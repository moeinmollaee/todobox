let currentAudio = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "play-sound" && msg.file) {
    stopCurrent();
    currentAudio = new Audio(msg.file);
    currentAudio.play().catch(() => {});
    currentAudio.addEventListener("ended", () => {
      currentAudio = null;
    });
    return;
  }
  if (msg?.type === "stop-sound") {
    stopCurrent();
  }
});

function stopCurrent() {
  if (!currentAudio) return;
  currentAudio.pause();
  currentAudio.currentTime = 0;
  currentAudio = null;
}
