// ============================================================
//  ① Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹) 의 설정값을 붙여넣으세요.
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyCe5UHCj3k59k73-SLSjL3o9S-c7HeYdJc",
  authDomain: "osong-interview.firebaseapp.com",
  projectId: "osong-interview",
  storageBucket: "osong-interview.firebasestorage.app",
  messagingSenderId: "1072441799187",
  appId: "1:1072441799187:web:a1fbae9ac95a03087805e6",
  measurementId: "G-EME9FJH5X5"
};

// ============================================================
//  ② 최고 관리자 이메일 — firestore.rules 의 adminEmails() 목록과 반드시 같게.
//     (처음 설정용. 이후 지도교사 계정에 '관리자' 권한을 줄 수도 있습니다)
// ============================================================
export const ADMIN_EMAILS = [
  "2min095156@gmail.com"
];

// 로그인 ID를 Firebase Auth 이메일로 바꿀 때 쓰는 가상 도메인. 운영 중 바꾸지 마세요.
export const LOGIN_EMAIL_DOMAIN = "osong-interview.app";

export const SCHOOL_NAME = "오송고";
export const PROGRAM_NAME = "2026 대입 면접 대비";
