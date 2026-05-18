import { useState, useEffect } from "react";

export const useDarkMode = (): {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
} => {
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    // Check if dark mode preference exists in localStorage
    const savedMode = localStorage.getItem("darkMode");
    if (savedMode !== null) {
      return JSON.parse(savedMode);
    }
    // Otherwise check system preference
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    // Apply or remove dark class on document root
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    // Save preference to localStorage
    localStorage.setItem("darkMode", JSON.stringify(isDarkMode));

    // Broadcast dark mode change to main process
    if (window.electron) {
      window.electron.ipcRenderer.send("dark-mode-changed", isDarkMode);
    }
  }, [isDarkMode]);

  // Listen for dark mode changes from other windows
  useEffect(() => {
    const handleDarkModeUpdate = (
      _event: unknown,
      newDarkMode: boolean,
    ): void => {
      setIsDarkMode(newDarkMode);
    };

    if (window.electron) {
      window.electron.ipcRenderer.on("dark-mode-updated", handleDarkModeUpdate);
    }

    return () => {
      if (window.electron) {
        window.electron.ipcRenderer.removeListener(
          "dark-mode-updated",
          handleDarkModeUpdate,
        );
      }
    };
  }, []);

  const toggleDarkMode = (): void => {
    setIsDarkMode(!isDarkMode);
  };

  return { isDarkMode, toggleDarkMode };
};
