import { useState, useEffect, useRef, useCallback } from 'react';
import AgoraRTC from 'agora-rtc-sdk-ng';

export function useAgora({ channel, uid, sessionType = 'audio', token: tokenProp }) {
  const clientRef = useRef(null);

  const [localTracks, setLocalTracks] = useState({ mic: null, cam: null });
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [joined, setJoined]           = useState(false);
  const [micMuted, setMicMuted]       = useState(false);
  const [camOff, setCamOff]           = useState(false);
  const [error, setError]             = useState(null);

  const appId = import.meta.env.VITE_AGORA_APP_ID;

  useEffect(() => {
    if (!appId || !channel) return;

    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    clientRef.current = client;

    client.on('user-published', async (user, mediaType) => {
      await client.subscribe(user, mediaType);
      setRemoteUsers(prev => {
        const without = prev.filter(u => u.uid !== user.uid);
        return [...without, user];
      });
    });

    client.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'video') {
        setRemoteUsers(prev =>
          prev.map(u => u.uid === user.uid ? { ...u, videoTrack: null } : u)
        );
      }
    });

    client.on('user-left', (user) => {
      setRemoteUsers(prev => prev.filter(u => u.uid !== user.uid));
    });

    async function join() {
      try {
        // Use token from URL (passed by server) — no API refetch needed
        const token = tokenProp ?? null;

        console.log('Agora joining:', { appId: appId?.substring(0, 6), channel, tokenLength: token?.length });

        await client.join(appId, channel, token, uid ?? null);

        const isVideo = sessionType === 'video';
        const tracks = isVideo
          ? await AgoraRTC.createMicrophoneAndCameraTracks()
          : [await AgoraRTC.createMicrophoneTrack()];

        const mic = tracks[0];
        const cam = isVideo ? tracks[1] : null;

        await client.publish(isVideo ? [mic, cam] : [mic]);
        setLocalTracks({ mic, cam });
        setJoined(true);
        console.log('✅ Agora joined successfully');
      } catch (err) {
        console.error('Agora join error:', err);
        setError(err.message || 'Failed to join call');
      }
    }

    join();

    return () => {
      setLocalTracks(prev => {
        prev.mic?.close();
        prev.cam?.close();
        return { mic: null, cam: null };
      });
      client.leave().catch(() => {});
      setJoined(false);
      setRemoteUsers([]);
    };
  }, [appId, channel, uid, sessionType, tokenProp]);

  const toggleMic = useCallback(async () => {
    if (!localTracks.mic) return;
    await localTracks.mic.setMuted(!micMuted);
    setMicMuted(m => !m);
  }, [localTracks.mic, micMuted]);

  const toggleCam = useCallback(async () => {
    if (!localTracks.cam) return;
    await localTracks.cam.setMuted(!camOff);
    setCamOff(c => !c);
  }, [localTracks.cam, camOff]);

  const leave = useCallback(async () => {
    localTracks.mic?.close();
    localTracks.cam?.close();
    await clientRef.current?.leave();
    setJoined(false);
    setLocalTracks({ mic: null, cam: null });
    setRemoteUsers([]);
  }, [localTracks]);

  return {
    localTracks,
    remoteUsers,
    joined,
    micMuted,
    camOff,
    error,
    toggleMic,
    toggleCam,
    leave,
  };
}