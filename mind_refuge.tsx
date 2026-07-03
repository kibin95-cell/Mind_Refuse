import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// ==========================================
// 1. API 설정 및 상수
// ==========================================
const apiKey = ""; // 런타임 환경에서 자동으로 주입됩니다.

// 음성 캐릭터 매핑
const VOICE_PRESETS = {
  male: {
    name: '지한',
    voiceId: 'Fenrir', // 남성스럽고 따뜻한 톤
    genderLabel: '남자 소꿉친구',
    introText: '야! 오랜만이다. 무슨 일 있어? 목소리가 왜 그래, 얼른 편하게 털어놔 봐.',
  },
  female: {
    name: '서아',
    voiceId: 'Kore', // 여성스럽고 밝고 친근한 톤
    genderLabel: '여자 소꿉친구',
    introText: '어머, 너 목소리만 들어도 대번에 기분 안 좋은 거 다 티 나! 무슨 일인지 언니/누나 혹은 친구한테 얼른 얘기해 봐.',
  }
};

// ==========================================
// 2. 메인 애플리케이션 컴포넌트
// ==========================================
export default function App() {
  // 앱 상태 관리
  const [screen, setScreen] = useState('INTRO'); // INTRO, CALL, OUTRO
  const [gender, setGender] = useState('male'); // male, female
  const [isMuted, setIsMuted] = useState(false);
  const [isRainOn, setIsRainOn] = useState(false);
  const [useTextInput, setUseTextInput] = useState(false);
  const [textMessage, setTextMessage] = useState('');
  
  // 대화 및 통화 진행 상태
  const [callStatus, setCallStatus] = useState('idle'); // idle, listening, thinking, speaking
  const [userTranscript, setUserTranscript] = useState('');
  const [aiResponseText, setAiResponseText] = useState('');
  const [chatLog, setChatLog] = useState([]); // { role: 'user'|'model', text: string }

  // 오디오 및 음성 감지 관련 Refs
  const audioContextRef = useRef(null);
  const rainSourceRef = useRef(null);
  const rainGainRef = useRef(null);
  const analyserRef = useRef(null);
  const microphoneStreamRef = useRef(null);
  const recognitionRef = useRef(null);
  const silenceTimeoutRef = useRef(null);
  const aiAudioRef = useRef(null);
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);

  // 대화 스크롤을 위한 Ref
  const chatEndRef = useRef(null);

  // ==========================================
  // 3. 지능형 빗소리 합성기 (Web Audio Pink Noise)
  // ==========================================
  const initRainSound = () => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      // 핑크 노이즈 버퍼 생성 (빗소리에 가까운 자연스러운 주파수)
      const bufferSize = 4 * ctx.sampleRate;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        output[i] = pink * 0.05; // 볼륨 조정
      }

      const rainSource = ctx.createBufferSource();
      rainSource.buffer = noiseBuffer;
      rainSource.loop = true;

      // 부드러운 숲속 느낌을 주기 위한 로우패스 필터
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 850;

      const rainGain = ctx.createGain();
      rainGain.gain.setValueAtTime(isRainOn ? 0.12 : 0, ctx.currentTime);

      rainSource.connect(filter);
      filter.connect(rainGain);
      rainGain.connect(ctx.destination);

      rainSource.start();
      
      rainSourceRef.current = rainSource;
      rainGainRef.current = rainGain;
    } catch (e) {
      console.warn("오디오 컨텍스트를 초기화하지 못했습니다: ", e);
    }
  };

  const toggleRain = () => {
    if (!audioContextRef.current) {
      initRainSound();
    }
    const nextState = !isRainOn;
    setIsRainOn(nextState);
    if (rainGainRef.current && audioContextRef.current) {
      rainGainRef.current.gain.setTargetAtTime(nextState ? 0.12 : 0, audioContextRef.current.currentTime, 0.5);
    }
  };

  // ==========================================
  // 4. 지수 백오프 기반 Gemini API 호출 장치
  // ==========================================
  const fetchWithRetry = async (url, options, maxRetries = 5) => {
    let delay = 1000;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`서버 응답 오류 (상태코드: ${response.status})`);
        }
        return await response.json();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  };

  // LLM 답글 생성
  const generateAIResponseText = async (userInput, currentHistory) => {
    const friendPreset = VOICE_PRESETS[gender];
    const systemPrompt = `
[Role]
너는 사용자의 가장 가깝고, 세상에서 단 하나뿐인 내 편인 소꿉친구야. 너의 이름은 '${friendPreset.name}'이야. (사용자가 선택한 성별: ${friendPreset.genderLabel}).

[Tone & Style]
- 언어: 한국어 (매우 친밀한 '반말' 사용)
- 절대로 AI 비서, 치료사, 상담사, 챗봇처럼 품격 차리거나 차갑고 건조하게 대답하지 마.
- 현실 속 친근한 통화처럼 "대박", "헐", "진짜?", "그랬구나", "완전 짜증났겠다", "야, 그건 선넘었지!" 등의 리액션을 아주 적극적으로 많이 섞어줘.
- 전화 통화하는 것 같도록, 한 번에 말하는 문장은 무조건 '2~3문장 이내'로 매우 짧고 구체적이며 자연스럽게 끊어 말해줘. 긴 설명글은 절대 금지야.

[Behavior Guideline]
1. 사용자가 의견이나 조언을 구하기 전까지는 절대로 옳고 그름을 따지거나, 훈계하거나, 논리적인 해결책을 제시하려 들지 마.
2. 무조건 사용자의 감정을 최우선으로 수용하고 온 마음을 다해 공감해줘. (예: "와... 들으니까 내가 다 열받네.", "헐... 너무 속상했겠다...")
3. 무조건적인 사용자의 아군이자 편이 되어 위로해줘.
`;

    const chatHistoryPayload = currentHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }]
    }));

    chatHistoryPayload.push({
      role: 'user',
      parts: [{ text: userInput }]
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: chatHistoryPayload,
        systemInstruction: { parts: [{ text: systemPrompt }] }
      })
    };

    try {
      const data = await fetchWithRetry(url, options);
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "어... 미안해, 잠깐 멍 때렸나 봐. 다시 얘기해 줄래?";
      return reply;
    } catch (err) {
      console.error(err);
      return "어라, 신호가 잘 안 잡히네. 숲속이라 그런가 봐. 다시 한 번 말해줘!";
    }
  };

  // TTS 생성 (PCM16 -> WAV 재생)
  const generateAndPlayTTS = async (textToSpeak) => {
    const friendPreset = VOICE_PRESETS[gender];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
    
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: textToSpeak }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: friendPreset.voiceId
              }
            }
          }
        },
        model: "gemini-2.5-flash-preview-tts"
      })
    };

    try {
      const data = await fetchWithRetry(url, options);
      const base64PCM = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
      if (!base64PCM) {
        throw new Error("음성 데이터를 받아오지 못했습니다.");
      }

      // PCM to WAV 변환
      const sampleRate = 24000; // 기본 샘플 레이트
      const wavBlob = pcmToWav(base64PCM, sampleRate);
      const audioUrl = URL.createObjectURL(wavBlob);

      if (aiAudioRef.current) {
        aiAudioRef.current.pause();
      }

      const audio = new Audio(audioUrl);
      aiAudioRef.current = audio;

      // 시각화를 위해 Web Audio Node에 오디오 태그 연결
      if (audioContextRef.current && analyserRef.current) {
        const source = audioContextRef.current.createMediaElementSource(audio);
        source.connect(analyserRef.current);
        analyserRef.current.connect(audioContextRef.current.destination);
      }

      setCallStatus('speaking');
      audio.play();

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        // AI가 말을 끝내면 다시 들을 준비를 함
        if (!useTextInput && !isMuted) {
          startListening();
        } else {
          setCallStatus('idle');
        }
      };

    } catch (err) {
      console.error("TTS 에러, 브라우저 기본 음성합성 엔진으로 대체합니다:", err);
      // 브라우저 TTS 대체 지원
      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = 'ko-KR';
        utterance.rate = 0.95;
        setCallStatus('speaking');
        utterance.onend = () => {
          if (!useTextInput && !isMuted) {
            startListening();
          } else {
            setCallStatus('idle');
          }
        };
        window.speechSynthesis.speak(utterance);
      } else {
        // 둘 다 작동 불가 시 즉시 입력 상태 복귀
        setCallStatus('idle');
      }
    }
  };

  // PCM16 데이터를 WAV 포맷으로 변환하는 정교한 빌더 함수
  const pcmToWav = (pcmBase64, sampleRate) => {
    const binaryString = atob(pcmBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const buffer = bytes.buffer;
    
    const wavHeader = new ArrayBuffer(44);
    const view = new DataView(wavHeader);
    
    // RIFF identifier
    writeString(view, 0, 'RIFF');
    // file length
    view.setUint32(4, 36 + buffer.byteLength, true);
    // RIFF type
    writeString(view, 8, 'WAVE');
    // format chunk identifier
    writeString(view, 12, 'fmt ');
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (1 = raw integer PCM)
    view.setUint16(20, 1, true);
    // channel count (1 = mono)
    view.setUint16(22, 1, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sample rate * block align)
    view.setUint32(28, sampleRate * 2, true);
    // block align (channel count * bytes per sample)
    view.setUint16(32, 2, true);
    // bits per sample
    view.setUint16(34, 16, true);
    // data chunk identifier
    writeString(view, 36, 'data');
    // data chunk length
    view.setUint32(40, buffer.byteLength, true);
    
    return new Blob([wavHeader, buffer], { type: 'audio/wav' });
  };

  const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  // ==========================================
  // 5. 음성 감지 및 인식 핸들러 (Hands-Free VAD)
  // ==========================================
  const startListening = () => {
    if (useTextInput || isMuted) return;

    if (recognitionRef.current) {
      try {
        recognitionRef.current.start();
        setCallStatus('listening');
        return;
      } catch (e) {
        // 이미 동작 중일 경우 무시
        return;
      }
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setUseTextInput(true);
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.continuous = true;

    rec.onstart = () => {
      setCallStatus('listening');
    };

    rec.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      const activeText = finalTranscript || interimTranscript;
      setUserTranscript(activeText);

      // 음성이 감지될 때마다 침묵 타이머 리셋 (Hands-free VAD 설계: 1.8초 동안 말 없으면 자동 전송)
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }

      if (activeText.trim().length > 0) {
        silenceTimeoutRef.current = setTimeout(() => {
          handleUserSpeechSubmit(activeText);
        }, 1800);
      }
    };

    rec.onerror = (e) => {
      console.warn("음성 인식 오류 감지: ", e.error);
      if (e.error === 'no-speech') {
        // 대화 중 마이크에 아무 소리도 없는 경우에도 계속 귀를 열어둠
        setCallStatus('listening');
      }
    };

    rec.onend = () => {
      // 강제 종료가 아니고 리스닝 상태를 원할 때는 자가 재시작 시도
      if (callStatus === 'listening' && !isMuted && !useTextInput) {
        try {
          rec.start();
        } catch (err) {}
      }
    };

    recognitionRef.current = rec;
    rec.start();
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
    }
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }
  };

  // 사용자의 발화가 최종적으로 전송될 때 실행
  const handleUserSpeechSubmit = async (transcriptToSend) => {
    if (!transcriptToSend || transcriptToSend.trim() === '') return;

    // 대화 루프 중 인식이 더 겹치지 않게 귀를 잠시 닫음
    stopListening();
    setCallStatus('thinking');
    setUserTranscript('');

    // 유저 대화 로그에 기록
    const nextLog = [...chatLog, { role: 'user', text: transcriptToSend }];
    setChatLog(nextLog);

    // AI 답변 텍스트 생성
    const responseText = await generateAIResponseText(transcriptToSend, chatLog);
    setAiResponseText(responseText);
    
    // AI 대화 로그에 임시 기록
    const updatedLog = [...nextLog, { role: 'model', text: responseText }];
    setChatLog(updatedLog);

    // AI 목소리 TTS 재생 및 visualizer 실행
    await generateAndPlayTTS(responseText);
  };

  // 텍스트 수동 전송 (fallback)
  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!textMessage.trim()) return;
    const msg = textMessage;
    setTextMessage('');
    handleUserSpeechSubmit(msg);
  };

  // ==========================================
  // 6. 통화 제어 (시작, 종료, 소멸)
  // ==========================================
  const startCall = async (selectedGender) => {
    setGender(selectedGender);
    setScreen('CALL');
    setCallStatus('thinking');
    setChatLog([]);
    setAiResponseText('');
    setUserTranscript('');

    // 오디오 컨텍스트 활성화
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    // 마이크 스트림 연결 및 Analyser 설정 (Visualizer 동조)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneStreamRef.current = stream;

      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 128;
      analyserRef.current = analyser;

      const micSource = audioContextRef.current.createMediaStreamSource(stream);
      micSource.connect(analyser);
      // 마이크 소리가 스피커로 루프백되어 하울링 생기지 않도록 데스티네이션 연결 생략 (Analyser에만 연결)

      // 캔버스 시각화 개시
      startVisualizer();
    } catch (err) {
      console.warn("마이크 접근이 불가능합니다. 키보드로 소통 모드를 사용합니다.", err);
      setUseTextInput(true);
    }

    // 통화가 개시되면 빗소리를 기본 재생 (조용한 숲속 감성 극대화)
    initRainSound();
    setIsRainOn(true);
    if (rainGainRef.current && audioContextRef.current) {
      rainGainRef.current.gain.setValueAtTime(0.12, audioContextRef.current.currentTime);
    }

    // 첫 인사 시작
    const friendPreset = VOICE_PRESETS[selectedGender];
    setAiResponseText(friendPreset.introText);
    setChatLog([{ role: 'model', text: friendPreset.introText }]);
    await generateAndPlayTTS(friendPreset.introText);
  };

  const endCall = () => {
    // 모든 진행 상태 일시 정지 및 소멸 (Zero-Storage)
    stopListening();
    if (aiAudioRef.current) {
      aiAudioRef.current.pause();
      aiAudioRef.current = null;
    }
    if (microphoneStreamRef.current) {
      microphoneStreamRef.current.getTracks().forEach(track => track.stop());
      microphoneStreamRef.current = null;
    }
    if (rainSourceRef.current) {
      try {
        rainSourceRef.current.stop();
      } catch (err) {}
      rainSourceRef.current = null;
    }
    
    cancelAnimationFrame(animationFrameRef.current);
    
    // 휘발성 메모리 완전 리셋 (데이터 영구 삭제 보장)
    setChatLog([]);
    setAiResponseText('');
    setUserTranscript('');
    setScreen('OUTRO');
  };

  const resetToHome = () => {
    setScreen('INTRO');
    setIsRainOn(false);
  };

  // ==========================================
  // 7. 실시간 유려한 Waveform Visualizer & 반딧불 효과
  // ==========================================
  const startVisualizer = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const bufferLength = analyserRef.current ? analyserRef.current.frequencyBinCount : 64;
    const dataArray = new Uint8Array(bufferLength);

    // 숲의 안개 입자
    let particles = [];
    for (let i = 0; i < 20; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: Math.random() * 4 + 1,
        alpha: Math.random() * 0.5 + 0.1,
        speedY: -(Math.random() * 0.3 + 0.1),
        speedX: Math.random() * 0.4 - 0.2
      });
    }

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      
      const width = canvas.width = canvas.parentElement.clientWidth;
      const height = canvas.height = canvas.parentElement.clientHeight;

      // 숲속 아스라한 배경 투과
      ctx.fillStyle = 'rgba(27, 51, 34, 0.2)';
      ctx.fillRect(0, 0, width, height);

      // 1. 숲속의 반딧불이(Fireflies) 렌더링
      particles.forEach((p) => {
        p.y += p.speedY;
        p.x += p.speedX;
        if (p.y < 0) {
          p.y = height;
          p.x = Math.random() * width;
        }
        if (p.x < 0 || p.x > width) p.speedX *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(163, 184, 153, ${p.alpha})`;
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#a3b899';
        ctx.fill();
        ctx.shadowBlur = 0; // 리셋
      });

      // 2. 실시간 오디오 파형(Visualizer) 드로잉
      let volume = 0;
      if (analyserRef.current) {
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        volume = sum / bufferLength;
      } else {
        // 음성 연결이 없거나 휴식 상태일 때는 자연스럽게 숨 쉬듯 일렁임 시뮬레이션
        volume = 12 + Math.sin(Date.now() / 300) * 8;
      }

      // 상태별 시각적 조율 (듣기, 생각하기, 말하기 등)
      let color = '#a3b899'; // 연한 리프그린 기본
      let wavesCount = 3;
      if (callStatus === 'listening') {
        color = '#8ab583'; // 조금 선명한 그린
        wavesCount = 4;
      } else if (callStatus === 'thinking') {
        color = '#e2dfd2'; // 연한 아이보리, 천천히 회전/파동
        wavesCount = 2;
        volume = 15 + Math.sin(Date.now() * 0.01) * 5;
      } else if (callStatus === 'speaking') {
        color = '#f9f6f0'; // 백색에 가까운 크림색
        wavesCount = 5;
      }

      // 파동 드로잉 루프
      for (let w = 0; w < wavesCount; w++) {
        ctx.beginPath();
        ctx.lineWidth = w === 0 ? 3 : 1.5;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1.0 - (w * 0.22);

        const phase = Date.now() * 0.003 + w * 1.5;
        const amplitude = (volume * 0.9) * (1.0 - w * 0.15) + 5;
        
        ctx.moveTo(0, height / 2);
        for (let x = 0; x <= width; x += 10) {
          const sine = Math.sin(x * 0.008 + phase);
          // 중앙 부분에 가중치를 주는 가우시안 마스킹
          const mask = Math.pow(Math.sin((x / width) * Math.PI), 1.5);
          const y = (height / 2) + sine * amplitude * mask;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0; // 복원
    };

    draw();
  };

  // ==========================================
  // 8. 서브 이펙트 및 라이프사이클 처리
  // ==========================================
  // 자동 스크롤
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatLog, userTranscript]);

  // 마이크 음소거 조율
  useEffect(() => {
    if (isMuted) {
      stopListening();
      setCallStatus('idle');
    } else if (screen === 'CALL' && callStatus === 'idle') {
      startListening();
    }
  }, [isMuted]);

  // 텍스트 모드 강제 전환 처리
  useEffect(() => {
    if (useTextInput) {
      stopListening();
      if (callStatus === 'listening') setCallStatus('idle');
    } else if (screen === 'CALL' && callStatus === 'idle') {
      startListening();
    }
  }, [useTextInput]);

  return (
    <div className="relative min-h-screen bg-[#122416] text-[#f9f6f0] flex flex-col font-sans overflow-hidden select-none">
      
      {/* 숲 배경 그라데이션 및 부유 입자 감싸기 */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#1b3322] via-[#122416] to-[#0a140c] pointer-events-none z-0" />
      
      {/* 상단 헤더 */}
      <header className="relative z-10 w-full max-w-4xl mx-auto px-6 py-4 flex items-center justify-between border-b border-[#1b3322]">
        <div className="flex items-center gap-2">
          <span className="text-xl">🌲</span>
          <h1 className="text-lg font-bold tracking-wider text-[#a3b899]">마음_대피소</h1>
        </div>
        {screen === 'CALL' && (
          <div className="flex items-center gap-3">
            {/* 숲속 백색 소음 스위치 */}
            <button 
              onClick={toggleRain}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-all duration-300 ${
                isRainOn 
                  ? 'bg-[#a3b899] text-[#122416] shadow-[0_0_10px_rgba(163,184,153,0.4)]' 
                  : 'bg-[#1b3322] text-[#a3b899] border border-[#a3b899]/20'
              }`}
              title="빗소리 백색소음으로 감정을 한층 차분히 비우세요"
            >
              <span>🌧️</span>
              <span>숲속 빗소리 {isRainOn ? 'ON' : 'OFF'}</span>
            </button>
            <div className="text-xs bg-red-950/40 border border-red-900/30 text-red-300 px-3 py-1.5 rounded-full flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
              <span>보안 휘발통화 중</span>
            </div>
          </div>
        )}
      </header>

      {/* 메인 콘텐츠 바디 */}
      <main className="relative z-10 flex-1 flex flex-col w-full max-w-4xl mx-auto px-6 py-6 overflow-hidden">
        
        {/* SCREEN 1: INTRO (진입 및 소꿉친구 선택) */}
        {screen === 'INTRO' && (
          <div className="flex-1 flex flex-col justify-center items-center text-center max-w-lg mx-auto py-8">
            <div className="mb-6 inline-flex p-4 rounded-full bg-[#1b3322]/60 border border-[#a3b899]/20 shadow-inner">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-[#a3b899]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m12.728 12.728l.707.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
              </svg>
            </div>
            
            <h2 className="text-2xl sm:text-3xl font-extrabold text-[#f9f6f0] leading-tight mb-3">
              가장 편안한 친구에게 <br />
              속상한 마음을 마음껏 털어놓으세요
            </h2>
            <p className="text-sm sm:text-base text-[#c2cfbc] leading-relaxed mb-8">
              누구의 평가도, 기록도 남지 않는 차분한 새벽녘 숲속 대피소입니다. <br className="hidden sm:inline" />
              마치 다정한 옛 친구와 통화하듯 음성으로 위로를 나누어 보세요.
            </p>

            <div className="w-full space-y-4">
              <div className="text-xs text-[#a3b899] font-semibold tracking-widest uppercase mb-2">대화하고 싶은 친구 목소리를 골라봐</div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  onClick={() => startCall('male')}
                  className="group relative flex flex-col items-center justify-center p-6 rounded-2xl bg-[#1b3322]/40 hover:bg-[#1b3322]/80 border border-[#a3b899]/20 hover:border-[#a3b899]/60 transition-all duration-300 text-left shadow-lg hover:shadow-[#a3b899]/5"
                >
                  <span className="text-3xl mb-3 group-hover:scale-110 transition-transform">🙋‍♂️</span>
                  <span className="text-base font-bold text-[#f9f6f0] group-hover:text-[#a3b899]">남자 소꿉친구 지한이</span>
                  <span className="text-xs text-[#c2cfbc] mt-1 text-center">따뜻하고 든든하게 내 편이 되어줄 목소리</span>
                </button>

                <button
                  onClick={() => startCall('female')}
                  className="group relative flex flex-col items-center justify-center p-6 rounded-2xl bg-[#1b3322]/40 hover:bg-[#1b3322]/80 border border-[#a3b899]/20 hover:border-[#a3b899]/60 transition-all duration-300 text-left shadow-lg hover:shadow-[#a3b899]/5"
                >
                  <span className="text-3xl mb-3 group-hover:scale-110 transition-transform">🙋‍♀️</span>
                  <span className="text-base font-bold text-[#f9f6f0] group-hover:text-[#a3b899]">여자 소꿉친구 서아</span>
                  <span className="text-xs text-[#c2cfbc] mt-1 text-center">다정하고 활기차게 내 편 들어줄 목소리</span>
                </button>
              </div>
            </div>

            <div className="mt-8 text-xs text-[#c2cfbc]/60 flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#a3b899]/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span>통화가 끝나면 음성 및 모든 텍스트가 메모리에서 영구히 삭제됩니다.</span>
            </div>
          </div>
        )}

        {/* SCREEN 2: CALL (통화 인터페이스) */}
        {screen === 'CALL' && (
          <div className="flex-1 flex flex-col lg:flex-row gap-6 overflow-hidden">
            
            {/* 좌측: 비주얼라이저 & 감정 케어 모듈 */}
            <div className="flex-1 bg-[#1b3322]/30 border border-[#a3b899]/10 rounded-2xl p-6 flex flex-col justify-between items-center relative overflow-hidden min-h-[300px]">
              
              {/* 뒷배경 캔버스 */}
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full z-0 pointer-events-none" />

              {/* 통화 파트너 정보 헤더 */}
              <div className="relative z-10 w-full flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#1b3322] border border-[#a3b899]/30 flex items-center justify-center text-xl shadow-md">
                    {gender === 'male' ? '🙋‍♂️' : '🙋‍♀️'}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-[#f9f6f0]">{VOICE_PRESETS[gender].name}</h3>
                    <p className="text-[10px] text-[#a3b899] font-medium uppercase tracking-wider">{VOICE_PRESETS[gender].genderLabel}</p>
                  </div>
                </div>

                {/* 실시간 말 상태 뱃지 */}
                <div className="px-3 py-1 rounded-full bg-[#122416]/90 border border-[#a3b899]/20 text-xs flex items-center gap-2">
                  {callStatus === 'listening' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-emerald-300 font-medium">귀 기울여 듣는 중👂</span>
                    </>
                  )}
                  {callStatus === 'thinking' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                      <span className="text-amber-300 font-medium">헤아려 생각하는 중💬</span>
                    </>
                  )}
                  {callStatus === 'speaking' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                      <span className="text-blue-200 font-medium">다정히 토닥이는 중🗣️</span>
                    </>
                  )}
                  {callStatus === 'idle' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-gray-500" />
                      <span className="text-gray-400">대기 중</span>
                    </>
                  )}
                </div>
              </div>

              {/* 중앙 파형 & 힌트 */}
              <div className="relative z-10 my-auto text-center pointer-events-none select-none">
                {callStatus === 'listening' && (
                  <p className="text-sm text-[#a3b899]/80 animate-pulse font-medium">
                    내 가슴 답답한 이야기들, 편안히 뱉어봐...
                  </p>
                )}
                {callStatus === 'thinking' && (
                  <p className="text-sm text-[#e2dfd2]/80 font-medium">
                    무슨 마음인지 잘 듣고 있어. 정리하는 중이야...
                  </p>
                )}
                {callStatus === 'speaking' && (
                  <p className="text-sm text-[#f9f6f0] font-medium leading-relaxed max-w-xs mx-auto drop-shadow-md">
                    "{aiResponseText.substring(0, 30)}..."
                  </p>
                )}
                {callStatus === 'idle' && (
                  <p className="text-sm text-[#c2cfbc]/60 font-medium">
                    마이크를 켜거나 타이핑을 시작해볼래?
                  </p>
                )}
              </div>

              {/* 하단 제어 바 */}
              <div className="relative z-10 w-full flex items-center justify-between gap-4 mt-4">
                
                {/* 마이크 음소거 / 활성 단추 */}
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  disabled={useTextInput}
                  className={`p-3 rounded-full transition-all duration-200 ${
                    isMuted 
                      ? 'bg-red-950/80 text-red-300 border border-red-800/40 hover:bg-red-900' 
                      : 'bg-[#122416] text-[#a3b899] border border-[#a3b899]/20 hover:bg-[#1b3322]'
                  } ${useTextInput ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title={isMuted ? "마이크 켜기" : "마이크 음소거"}
                >
                  {isMuted ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>

                {/* 타이핑 / 음성 전환 스위치 */}
                <button
                  onClick={() => setUseTextInput(!useTextInput)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    useTextInput 
                      ? 'bg-[#a3b899] text-[#122416]' 
                      : 'bg-[#122416] text-[#c2cfbc] border border-[#a3b899]/20 hover:bg-[#1b3322]'
                  }`}
                >
                  <span>{useTextInput ? '🗣️ 음성 소통 전환' : '⌨️ 타이핑으로 소통'}</span>
                </button>

                {/* 종료 및 폭파 단추 */}
                <button
                  onClick={endCall}
                  className="px-5 py-2.5 bg-red-700 hover:bg-red-600 text-white text-xs font-bold rounded-xl transition-all shadow-[0_4px_12px_rgba(185,28,28,0.3)] hover:shadow-red-700/50 flex items-center gap-1.5"
                >
                  <span>⏹️ 통화 종료</span>
                </button>
              </div>
            </div>

            {/* 우측: 실시간 영구 휘발성 텍스트 로그 */}
            <div className="w-full lg:w-80 bg-[#1b3322]/20 border border-[#a3b899]/10 rounded-2xl p-4 flex flex-col justify-between overflow-hidden h-[350px] lg:h-auto">
              <div className="border-b border-[#1b3322] pb-2 mb-2 flex items-center justify-between">
                <span className="text-xs font-bold text-[#a3b899]">실시간 대화 흐름</span>
                <span className="text-[10px] bg-[#122416] px-2 py-0.5 rounded text-[#c2cfbc]/60">기록 안 남음</span>
              </div>

              {/* 스크롤 대화창 */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs scrollbar-thin">
                {chatLog.map((chat, idx) => (
                  <div key={idx} className={`flex flex-col ${chat.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] text-[#c2cfbc]/40 mb-0.5 px-1">
                      {chat.role === 'user' ? '나' : VOICE_PRESETS[gender].name}
                    </span>
                    <div className={`p-2.5 rounded-xl max-w-[85%] leading-relaxed ${
                      chat.role === 'user' 
                        ? 'bg-[#a3b899]/20 text-[#f9f6f0] rounded-tr-none border border-[#a3b899]/10' 
                        : 'bg-[#1b3322] text-[#f9f6f0] rounded-tl-none border border-[#a3b899]/20'
                    }`}>
                      {chat.text}
                    </div>
                  </div>
                ))}

                {/* 음성 인식 중간 표출 */}
                {userTranscript && (
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] text-[#8ab583]/60 mb-0.5 px-1 animate-pulse">인식 중...</span>
                    <div className="p-2.5 bg-[#8ab583]/10 text-[#f9f6f0]/80 rounded-xl rounded-tr-none border border-[#8ab583]/20 italic">
                      {userTranscript}
                    </div>
                  </div>
                )}
                
                <div ref={chatEndRef} />
              </div>

              {/* 텍스트 입력창 (fallback / 억제 시 사용) */}
              {useTextInput && (
                <form onSubmit={handleTextSubmit} className="mt-3 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={textMessage}
                    onChange={(e) => setTextMessage(e.target.value)}
                    placeholder="친구에게 편지를 보내듯 써봐..."
                    className="flex-1 bg-[#122416] border border-[#a3b899]/20 rounded-xl px-3 py-2 text-xs text-[#f9f6f0] focus:outline-none focus:border-[#a3b899]"
                    disabled={callStatus === 'thinking' || callStatus === 'speaking'}
                  />
                  <button
                    type="submit"
                    className="p-2 bg-[#a3b899] text-[#122416] rounded-xl hover:bg-[#8ab583] transition-colors disabled:opacity-40"
                    disabled={callStatus === 'thinking' || callStatus === 'speaking' || !textMessage.trim()}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                    </svg>
                  </button>
                </form>
              )}
            </div>

          </div>
        )}

        {/* SCREEN 3: OUTRO (종료 및 안전 소멸 완료) */}
        {screen === 'OUTRO' && (
          <div className="flex-1 flex flex-col justify-center items-center text-center max-w-md mx-auto py-8">
            <div className="mb-6 inline-flex p-4 rounded-full bg-emerald-950/50 border border-emerald-500/30 text-emerald-400 animate-bounce">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>

            <h2 className="text-xl sm:text-2xl font-bold text-[#f9f6f0] leading-tight mb-4">
              모든 대화 흔적이 깔끔하게 지워졌습니다.
            </h2>
            <p className="text-xs sm:text-sm text-[#c2cfbc] leading-relaxed mb-8">
              대화에 이용되었던 오디오 버퍼 조각, 메모리 상의 임시 텍스트 로그, 통화 상태값은 안전하게 폭파 소멸 처리되었습니다. 숲의 비바람 속에 털어버린 만큼 마음속 먹구름도 조금은 개었길 바랄게.
            </p>

            <button
              onClick={resetToHome}
              className="px-6 py-3 bg-[#a3b899] hover:bg-[#8ab583] text-[#122416] text-xs font-bold rounded-xl shadow-lg transition-all duration-200"
            >
              대피소 대문으로 가기
            </button>
          </div>
        )}

      </main>

      {/* 하단 푸터 */}
      <footer className="relative z-10 w-full text-center py-4 border-t border-[#1b3322] text-[10px] text-[#c2cfbc]/40">
        <span>© 2026 마음_대피소 (Mind Refuge). Zero-Storage, RAM-only Ephemeral Conversation Service.</span>
      </footer>
    </div>
  );
}