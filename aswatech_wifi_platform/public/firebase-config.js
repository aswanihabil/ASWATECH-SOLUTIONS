
/*
  ASWA-TECH SOLUTIONS
  WiFi Hosting Platform
  Firebase Configuration
*/

const firebaseConfig = {
  apiKey: "AIzaSyCwDqiMZaAHG_MfgVFv_XO49X-HagsdLvA",
  authDomain: "aswa-tech-solutions-85761.firebaseapp.com",
  databaseURL: "https://aswa-tech-solutions-85761-default-rtdb.firebaseio.com",
  projectId: "aswa-tech-solutions-85761",
  storageBucket: "aswa-tech-solutions-85761.firebasestorage.app",
  messagingSenderId: "28880855111",
  appId: "1:28880855111:web:887d7ec5d3c6c19a275162"
};

// Initialize Firebase once.
if (typeof firebase !== "undefined" && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// Make Firebase services available to the other JavaScript files.
if (typeof firebase !== "undefined") {
  window.auth = firebase.auth();
  window.db = firebase.firestore();
}

console.log("ASWA-TECH Firebase configuration loaded.");
