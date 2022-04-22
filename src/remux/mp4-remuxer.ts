import AAC from './aac-helper';
import MP4 from './mp4-generator';
import type { HlsEventEmitter } from '../events';
import { Events } from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';
import { logger } from '../utils/logger';
import {
  InitSegmentData,
  Remuxer,
  RemuxerResult,
  RemuxedMetadata,
  RemuxedTrack,
  RemuxedUserdata,
} from '../types/remuxer';
import { PlaylistLevelType } from '../types/loader';
import { toMsFromMpegTsClock } from '../utils/timescale-conversion';
import type {
  AudioSample,
  AvcSample,
  DemuxedAudioTrack,
  DemuxedAvcTrack,
  DemuxedMetadataTrack,
  DemuxedUserdataTrack,
} from '../types/demuxer';
import type { TrackSet } from '../types/track';
import type { SourceBufferName } from '../types/buffer';
import type { Fragment } from '../loader/fragment';
import type { HlsConfig } from '../config';

const MAX_SILENT_FRAME_DURATION = 10 * 1000; // 10 seconds
const AAC_SAMPLES_PER_FRAME = 1024;
const MPEG_AUDIO_SAMPLE_PER_FRAME = 1152;

let chromeVersion: number | null = null;
let safariWebkitVersion: number | null = null;
let requiresPositiveDts: boolean = false;

export default class MP4Remuxer implements Remuxer {
  private observer: HlsEventEmitter;
  private config: HlsConfig;
  private typeSupported: any;
  private ISGenerated: boolean = false;
  private _initPTS!: number;
  private _initDTS!: number;
  private nextAvcDts: number | null = null;
  private nextAudioPts: number | null = null;
  private isAudioContiguous: boolean = false;
  private isVideoContiguous: boolean = false;

  constructor(
    observer: HlsEventEmitter,
    config: HlsConfig,
    typeSupported,
    vendor = ''
  ) {
    this.observer = observer;
    this.config = config;
    this.typeSupported = typeSupported;
    this.ISGenerated = false;

    if (chromeVersion === null) {
      const userAgent = navigator.userAgent || '';
      const result = userAgent.match(/Chrome\/(\d+)/i);
      chromeVersion = result ? parseInt(result[1]) : 0;
    }
    if (safariWebkitVersion === null) {
      const result = navigator.userAgent.match(/Safari\/(\d+)/i);
      safariWebkitVersion = result ? parseInt(result[1]) : 0;
    }
    requiresPositiveDts =
      (!!chromeVersion && chromeVersion < 75) ||
      (!!safariWebkitVersion && safariWebkitVersion < 600);
  }

  destroy() {}

  resetTimeStamp(defaultTimeStamp) {
    logger.log('[mp4-remuxer]: initPTS & initDTS reset');
    this._initPTS = this._initDTS = defaultTimeStamp;
  }

  resetNextTimestamp() {
    logger.log('[mp4-remuxer]: reset next timestamp');
    this.isVideoContiguous = false;
    this.isAudioContiguous = false;
  }

  resetInitSegment() {
    logger.log('[mp4-remuxer]: ISGenerated flag reset');
    this.ISGenerated = false;
  }

  getVideoStartPts(videoSamples) {
    let rolloverDetected = false;
    const startPTS = videoSamples.reduce((minPTS, sample) => {
      const delta = sample.pts - minPTS;
      if (delta < -4294967296) {
        // 2^32, see PTSNormalize for reasoning, but we're hitting a rollover here, and we don't want that to impact the timeOffset calculation
        rolloverDetected = true;
        return normalizePts(minPTS, sample.pts);
      } else if (delta > 0) {
        return minPTS;
      } else {
        return sample.pts;
      }
    }, videoSamples[0].pts);
    if (rolloverDetected) {
      logger.debug('PTS rollover detected');
    }
    return startPTS;
  }

  remux(
    audioTrack: DemuxedAudioTrack,
    videoTrack: DemuxedAvcTrack,
    id3Track: DemuxedMetadataTrack,
    textTrack: DemuxedUserdataTrack,
    timeOffset: number,
    accurateTimeOffset: boolean,
    flush: boolean,
    playlistType: PlaylistLevelType
  ): RemuxerResult {
    let video: RemuxedTrack | undefined;
    let audio: RemuxedTrack | undefined;
    let initSegment: InitSegmentData | undefined;
    let text: RemuxedUserdata | undefined;
    let id3: RemuxedMetadata | undefined;
    let independent: boolean | undefined;
    let audioTimeOffset = timeOffset;
    let videoTimeOffset = timeOffset;

    // If we're remuxing audio and video progressively, wait until we've received enough samples for each track before proceeding.
    // This is done to synchronize the audio and video streams. We know if the current segment will have samples if the "pid"
    // parameter is greater than -1. The pid is set when the PMT is parsed, which contains the tracks list.
    // However, if the initSegment has already been generated, or we've reached the end of a segment (flush),
    // then we can remux one track without waiting for the other.
    const hasAudio = audioTrack.pid > -1;
    const hasVideo = videoTrack.pid > -1;
    const length = videoTrack.samples.length;
    const enoughAudioSamples = audioTrack.samples.length > 0;
    const enoughVideoSamples = length > 1;
    const canRemuxAvc =
      ((!hasAudio || enoughAudioSamples) &&
        (!hasVideo || enoughVideoSamples)) ||
      this.ISGenerated ||
      flush;

    if (canRemuxAvc) {
      if (!this.ISGenerated) {
        initSegment = this.generateIS(audioTrack, videoTrack, timeOffset);
      }

      const isVideoContiguous = this.isVideoContiguous;
      let firstKeyFrameIndex = -1;

      if (enoughVideoSamples) {
        firstKeyFrameIndex = findKeyframeIndex(videoTrack.samples);
        if (!isVideoContiguous && this.config.forceKeyFrameOnDiscontinuity) {
          independent = true;
          if (firstKeyFrameIndex > 0) {
            logger.warn(
              `[mp4-remuxer]: Dropped ${firstKeyFrameIndex} out of ${length} video samples due to a missing keyframe`
            );
            const startPTS = this.getVideoStartPts(videoTrack.samples);
            videoTrack.samples = videoTrack.samples.slice(firstKeyFrameIndex);
            videoTrack.dropped += firstKeyFrameIndex;
            videoTimeOffset +=
              (videoTrack.samples[0].pts - startPTS) /
              (videoTrack.timescale || 90000);
          } else if (firstKeyFrameIndex === -1) {
            logger.warn(
              `[mp4-remuxer]: No keyframe found out of ${length} video samples`
            );
            independent = false;
          }
        }
      }

      if (this.ISGenerated) {
        if (enoughAudioSamples && enoughVideoSamples) {
          // timeOffset is expected to be the offset of the first timestamp of this fragment (first DTS)
          // if first audio DTS is not aligned with first video DTS then we need to take that into account
          // when providing timeOffset to remuxAudio / remuxVideo. if we don't do that, there might be a permanent / small
          // drift between audio and video streams
          const startPTS = this.getVideoStartPts(videoTrack.samples);
          const tsDelta =
            normalizePts(audioTrack.samples[0].pts, startPTS) - startPTS;
          const audiovideoTimestampDelta = tsDelta / videoTrack.inputTimeScale;
          audioTimeOffset += Math.max(0, audiovideoTimestampDelta);
          videoTimeOffset += Math.max(0, -audiovideoTimestampDelta);
        }

        // Purposefully remuxing audio before video, so that remuxVideo can use nextAudioPts, which is calculated in remuxAudio.
        if (enoughAudioSamples) {
          // if initSegment was generated without audio samples, regenerate it again
          if (!audioTrack.samplerate) {
            logger.warn(
              '[mp4-remuxer]: regenerate InitSegment as audio detected'
            );
            initSegment = this.generateIS(audioTrack, videoTrack, timeOffset);
          }
          audio = this.remuxAudio(
            audioTrack,
            audioTimeOffset,
            this.isAudioContiguous,
            accurateTimeOffset,
            hasVideo ||
              enoughVideoSamples ||
              playlistType === PlaylistLevelType.AUDIO
              ? videoTimeOffset
              : undefined
          );
          if (enoughVideoSamples) {
            const audioTrackLength = audio ? audio.endPTS - audio.startPTS : 0;
            // if initSegment was generated without video samples, regenerate it again
            if (!videoTrack.inputTimeScale) {
              logger.warn(
                '[mp4-remuxer]: regenerate InitSegment as video detected'
              );
              initSegment = this.generateIS(audioTrack, videoTrack, timeOffset);
            }
            video = this.remuxVideo(
              videoTrack,
              videoTimeOffset,
              isVideoContiguous,
              audioTrackLength
            );
          }
        } else if (enoughVideoSamples) {
          video = this.remuxVideo(
            videoTrack,
            videoTimeOffset,
            isVideoContiguous,
            0
          );
        }
        if (video) {
          video.firstKeyFrame = firstKeyFrameIndex;
          video.independent = firstKeyFrameIndex !== -1;
        }
      }
    }

    // Allow ID3 and text to remux, even if more audio/video samples are required
    if (this.ISGenerated) {
      if (id3Track.samples.length) {
        id3 = flushTextTrackMetadataCueSamples(
          id3Track,
          timeOffset,
          this._initPTS,
          this._initDTS
        );
      }

      if (textTrack.samples.length) {
        text = flushTextTrackUserdataCueSamples(
          textTrack,
          timeOffset,
          this._initPTS
        );
      }
    }

    return {
      audio,
      video,
      initSegment,
      independent,
      text,
      id3,
    };
  }

  generateIS(
    audioTrack: DemuxedAudioTrack,
    videoTrack: DemuxedAvcTrack,
    timeOffset
  ): InitSegmentData | undefined {
    const audioSamples = audioTrack.samples;
    const videoSamples = videoTrack.samples;
    const typeSupported = this.typeSupported;
    const tracks: TrackSet = {};
    const computePTSDTS = !Number.isFinite(this._initPTS);
    let container = 'audio/mp4';
    let initPTS: number | undefined;
    let initDTS: number | undefined;
    let timescale: number | undefined;

    if (computePTSDTS) {
      initPTS = initDTS = Infinity;
    }

    if (audioTrack.config && audioSamples.length) {
      // let's use audio sampling rate as MP4 time scale.
      // rationale is that there is a integer nb of audio frames per audio sample (1024 for AAC)
      // using audio sampling rate here helps having an integer MP4 frame duration
      // this avoids potential rounding issue and AV sync issue
      audioTrack.timescale = audioTrack.samplerate;
      if (!audioTrack.isAAC) {
        if (typeSupported.mpeg) {
          // Chrome and Safari
          container = 'audio/mpeg';
          audioTrack.codec = '';
        } else if (typeSupported.mp3) {
          // Firefox
          audioTrack.codec = 'mp3';
        }
      }
      tracks.audio = {
        id: 'audio',
        container: container,
        codec: audioTrack.codec,
        initSegment:
          !audioTrack.isAAC && typeSupported.mpeg
            ? new Uint8Array(0)
            : MP4.initSegment([audioTrack]),
        metadata: {
          channelCount: audioTrack.channelCount,
        },
      };
      if (computePTSDTS) {
        timescale = audioTrack.inputTimeScale;
        // remember first PTS of this demuxing context. for audio, PTS = DTS
        initPTS = initDTS =
          audioSamples[0].pts - Math.round(timescale * timeOffset);
      }
    }

    if (videoTrack.sps && videoTrack.pps && videoSamples.length) {
      // let's use input time scale as MP4 video timescale
      // we use input time scale straight away to avoid rounding issues on frame duration / cts computation
      videoTrack.timescale = videoTrack.inputTimeScale;
      tracks.video = {
        id: 'main',
        container: 'video/mp4',
        codec: videoTrack.codec,
        initSegment: MP4.initSegment([videoTrack]),
        metadata: {
          width: videoTrack.width,
          height: videoTrack.height,
        },
      };
      if (computePTSDTS) {
        timescale = videoTrack.inputTimeScale;
        const startPTS = this.getVideoStartPts(videoSamples);
        const startOffset = Math.round(timescale * timeOffset);
        initDTS = Math.min(
          initDTS as number,
          normalizePts(videoSamples[0].dts, startPTS) - startOffset
        );
        initPTS = Math.min(initPTS as number, startPTS - startOffset);
      }
    }

    if (Object.keys(tracks).length) {
      this.ISGenerated = true;
      if (computePTSDTS) {
        this._initPTS = initPTS as number;
        this._initDTS = initDTS as number;
      }

      return {
        tracks,
        initPTS,
        timescale,
      };
    }
  }

  remuxVideo(
    track: DemuxedAvcTrack,
    timeOffset: number,
    contiguous: boolean,
    audioTrackLength: number
  ): RemuxedTrack | undefined {
    const timeScale: number = track.inputTimeScale;
    const inputSamples: Array<AvcSample> = track.samples;
    const outputSamples: Array<Mp4Sample> = [];
    const nbSamples: number = inputSamples.length;
    const initPTS: number = this._initPTS;
    let nextAvcDts = this.nextAvcDts;
    let offset = 8;
    let mp4SampleDuration!: number;
    let firstDTS;
    let lastDTS;
    let minPTS: number = Number.POSITIVE_INFINITY;
    let maxPTS: number = Number.NEGATIVE_INFINITY;
    let ptsDtsShift = 0;
    let sortSamples = false;

    // if parsed fragment is contiguous with last one, let's use last DTS value as reference
    if (!contiguous || nextAvcDts === null) {
      const pts = timeOffset * timeScale;
      const cts =
        inputSamples[0].pts -
        normalizePts(inputSamples[0].dts, inputSamples[0].pts);
      // if not contiguous, let's use target timeOffset
      nextAvcDts = pts - cts;
    }

    // PTS is coded on 33bits, and can loop from -2^32 to 2^32
    // PTSNormalize will make PTS/DTS value monotonic, we use last known DTS value as reference value
    for (let i = 0; i < nbSamples; i++) {
      const sample = inputSamples[i];
      sample.pts = normalizePts(sample.pts - initPTS, nextAvcDts);
      sample.dts = normalizePts(sample.dts - initPTS, nextAvcDts);
      if (sample.dts > sample.pts) {
        const PTS_DTS_SHIFT_TOLERANCE_90KHZ = 90000 * 0.2;
        ptsDtsShift = Math.max(
          Math.min(ptsDtsShift, sample.pts - sample.dts),
          -1 * PTS_DTS_SHIFT_TOLERANCE_90KHZ
        );
      }
      if (sample.dts < inputSamples[i > 0 ? i - 1 : i].dts) {
        sortSamples = true;
      }
    }

    // sort video samples by DTS then PTS then demux id order
    if (sortSamples) {
      inputSamples.sort(function (a, b) {
        const deltadts = a.dts - b.dts;
        const deltapts = a.pts - b.pts;
        return deltadts || deltapts;
      });
    }

    // Get first/last DTS
    firstDTS = inputSamples[0].dts;
    lastDTS = inputSamples[inputSamples.length - 1].dts;

    // on Safari let's signal the same sample duration for all samples
    // sample duration (as expected by trun MP4 boxes), should be the delta between sample DTS
    // set this constant duration as being the avg delta between consecutive DTS.
    const averageSampleDuration = Math.round(
      (lastDTS - firstDTS) / (nbSamples - 1)
    );

    // handle broken streams with PTS < DTS, tolerance up 0.2 seconds
    if (ptsDtsShift < 0) {
      if (ptsDtsShift < averageSampleDuration * -2) {
        // Fix for "CNN special report, with CC" in test-streams (including Safari browser)
        // With large PTS < DTS errors such as this, we want to correct CTS while maintaining increasing DTS values
        logger.warn(
          `PTS < DTS detected in video samples, offsetting DTS from PTS by ${toMsFromMpegTsClock(
            -averageSampleDuration,
            true
          )} ms`
        );
        let lastDts = ptsDtsShift;
        for (let i = 0; i < nbSamples; i++) {
          inputSamples[i].dts = lastDts = Math.max(
            lastDts,
            inputSamples[i].pts - averageSampleDuration
          );
          inputSamples[i].pts = Math.max(lastDts, inputSamples[i].pts);
        }
      } else {
        // Fix for "Custom IV with bad PTS DTS" in test-streams
        // With smaller PTS < DTS errors we can simply move all DTS back. This increases CTS without causing buffer gaps or decode errors in Safari
        logger.warn(
          `PTS < DTS detected in video samples, shifting DTS by ${toMsFromMpegTsClock(
            ptsDtsShift,
            true
          )} ms to overcome this issue`
        );
        for (let i = 0; i < nbSamples; i++) {
          inputSamples[i].dts = inputSamples[i].dts + ptsDtsShift;
        }
      }
      firstDTS = inputSamples[0].dts;
    }

    // if fragment are contiguous, detect hole/overlapping between fragments
    if (contiguous) {
      // check timestamp continuity across consecutive fragments (this is to remove inter-fragment gap/hole)
      const delta = firstDTS - nextAvcDts;
      const foundHole = delta > averageSampleDuration;
      const foundOverlap = delta < -1;
      if (foundHole || foundOverlap) {
        if (foundHole) {
          logger.warn(
            `AVC: ${toMsFromMpegTsClock(
              delta,
              true
            )} ms (${delta}dts) hole between fragments detected, filling it`
          );
        } else {
          logger.warn(
            `AVC: ${toMsFromMpegTsClock(
              -delta,
              true
            )} ms (${delta}dts) overlapping between fragments detected`
          );
        }
        firstDTS = nextAvcDts;
        const firstPTS = inputSamples[0].pts - delta;
        inputSamples[0].dts = firstDTS;
        inputSamples[0].pts = firstPTS;
        logger.log(
          `Video: First PTS/DTS adjusted: ${toMsFromMpegTsClock(
            firstPTS,
            true
          )}/${toMsFromMpegTsClock(
            firstDTS,
            true
          )}, delta: ${toMsFromMpegTsClock(delta, true)} ms`
        );
      }
    }

    if (requiresPositiveDts) {
      firstDTS = Math.max(0, firstDTS);
    }
    let nbNalu = 0;
    let naluLen = 0;
    for (let i = 0; i < nbSamples; i++) {
      // compute total/avc sample length and nb of NAL units
      const sample = inputSamples[i];
      const units = sample.units;
      const nbUnits = units.length;
      let sampleLen = 0;
      for (let j = 0; j < nbUnits; j++) {
        sampleLen += units[j].data.length;
      }

      naluLen += sampleLen;
      nbNalu += nbUnits;
      sample.length = sampleLen;

      // normalize PTS/DTS
      // ensure sample monotonic DTS
      sample.dts = Math.max(sample.dts, firstDTS);
      // ensure that computed value is greater or equal than sample DTS
      sample.pts = Math.max(sample.pts, sample.dts, 0);
      minPTS = Math.min(sample.pts, minPTS);
      maxPTS = Math.max(sample.pts, maxPTS);
    }
    lastDTS = inputSamples[nbSamples - 1].dts;

    /* concatenate the video data and construct the mdat in place
      (need 8 more bytes to fill length and mpdat type) */
    const mdatSize = naluLen + 4 * nbNalu + 8;
    let mdat;
    try {
      mdat = new Uint8Array(mdatSize);
    } catch (err) {
      this.observer.emit(Events.ERROR, Events.ERROR, {
        type: ErrorTypes.MUX_ERROR,
        details: ErrorDetails.REMUX_ALLOC_ERROR,
        fatal: false,
        bytes: mdatSize,
        reason: `fail allocating video mdat ${mdatSize}`,
      });
      return;
    }
    const view = new DataView(mdat.buffer);
    view.setUint32(0, mdatSize);
    mdat.set(MP4.types.mdat, 4);

    for (let i = 0; i < nbSamples; i++) {
      const avcSample = inputSamples[i];
      const avcSampleUnits = avcSample.units;
      let mp4SampleLength = 0;
      // convert NALU bitstream to MP4 format (prepend NALU with size field)
      for (let j = 0, nbUnits = avcSampleUnits.length; j < nbUnits; j++) {
        const unit = avcSampleUnits[j];
        const unitData = unit.data;
        const unitDataLen = unit.data.byteLength;
        view.setUint32(offset, unitDataLen);
        offset += 4;
        mdat.set(unitData, offset);
        offset += unitDataLen;
        mp4SampleLength += 4 + unitDataLen;
      }

      // expected sample duration is the Decoding Timestamp diff of consecutive samples
      if (i < nbSamples - 1) {
        mp4SampleDuration = inputSamples[i + 1].dts - avcSample.dts;
      } else {
        const config = this.config;
        const lastFrameDuration =
          avcSample.dts - inputSamples[i > 0 ? i - 1 : i].dts;
        if (config.stretchShortVideoTrack && this.nextAudioPts !== null) {
          // In some cases, a segment's audio track duration may exceed the video track duration.
          // Since we've already remuxed audio, and we know how long the audio track is, we look to
          // see if the delta to the next segment is longer than maxBufferHole.
          // If so, playback would potentially get stuck, so we artificially inflate
          // the duration of the last frame to minimize any potential gap between segments.
          const gapTolerance = Math.floor(config.maxBufferHole * timeScale);
          const deltaToFrameEnd =
            (audioTrackLength
              ? minPTS + audioTrackLength * timeScale
              : this.nextAudioPts) - avcSample.pts;
          if (deltaToFrameEnd > gapTolerance) {
            // We subtract lastFrameDuration from deltaToFrameEnd to try to prevent any video
            // frame overlap. maxBufferHole should be >> lastFrameDuration anyway.
            mp4SampleDuration = deltaToFrameEnd - lastFrameDuration;
            if (mp4SampleDuration < 0) {
              mp4SampleDuration = lastFrameDuration;
            }
            logger.log(
              `[mp4-remuxer]: It is approximately ${
                deltaToFrameEnd / 90
              } ms to the next segment; using duration ${
                mp4SampleDuration / 90
              } ms for the last video frame.`
            );
          } else {
            mp4SampleDuration = lastFrameDuration;
          }
        } else {
          mp4SampleDuration = lastFrameDuration;
        }
      }
      const compositionTimeOffset = Math.round(avcSample.pts - avcSample.dts);

      outputSamples.push(
        new Mp4Sample(
          avcSample.key,
          mp4SampleDuration,
          mp4SampleLength,
          compositionTimeOffset
        )
      );
    }

    if (outputSamples.length && chromeVersion && chromeVersion < 70) {
      // Chrome workaround, mark first sample as being a Random Access Point (keyframe) to avoid sourcebuffer append issue
      // https://code.google.com/p/chromium/issues/detail?id=229412
      const flags = outputSamples[0].flags;
      flags.dependsOn = 2;
      flags.isNonSync = 0;
    }

    console.assert(
      mp4SampleDuration !== undefined,
      'mp4SampleDuration must be computed'
    );
    // next AVC sample DTS should be equal to last sample DTS + last sample duration (in PES timescale)
    this.nextAvcDts = nextAvcDts = lastDTS + mp4SampleDuration;
    this.isVideoContiguous = true;
    const moof = MP4.moof(
      track.sequenceNumber++,
      firstDTS,
      Object.assign({}, track, {
        samples: outputSamples,
      })
    );
    const type: SourceBufferName = 'video';
    const data = {
      data1: moof,
      data2: mdat,
      startPTS: minPTS / timeScale,
      endPTS: (maxPTS + mp4SampleDuration) / timeScale,
      startDTS: firstDTS / timeScale,
      endDTS: (nextAvcDts as number) / timeScale,
      type,
      hasAudio: false,
      hasVideo: true,
      nb: outputSamples.length,
      dropped: track.dropped,
    };

    track.samples = [];
    track.dropped = 0;

    console.assert(mdat.length, 'MDAT length must not be zero');

    return data;
  }

  remuxAudio(
    track: DemuxedAudioTrack,
    timeOffset: number,
    contiguous: boolean,
    accurateTimeOffset: boolean,
    videoTimeOffset?: number
  ): RemuxedTrack | undefined {
    const inputTimeScale: number = track.inputTimeScale;
    const mp4timeScale: number = track.samplerate
      ? track.samplerate
      : inputTimeScale;
    const scaleFactor: number = inputTimeScale / mp4timeScale;
    const mp4SampleDuration: number = track.isAAC
      ? AAC_SAMPLES_PER_FRAME
      : MPEG_AUDIO_SAMPLE_PER_FRAME;
    const inputSampleDuration: number = mp4SampleDuration * scaleFactor;
    const initPTS: number = this._initPTS;
    const rawMPEG: boolean = !track.isAAC && this.typeSupported.mpeg;
    const outputSamples: Array<Mp4Sample> = [];

    let inputSamples: Array<AudioSample> = track.samples;
    let offset: number = rawMPEG ? 0 : 8;
    let nextAudioPts: number = this.nextAudioPts || -1;

    // window.audioSamples ? window.audioSamples.push(inputSamples.map(s => s.pts)) : (window.audioSamples = [inputSamples.map(s => s.pts)]);

    // for audio samples, also consider consecutive fragments as being contiguous (even if a level switch occurs),
    // for sake of clarity:
    // consecutive fragments are frags with
    //  - less than 100ms gaps between new time offset (if accurate) and next expected PTS OR
    //  - less than 20 audio frames distance
    // contiguous fragments are consecutive fragments from same quality level (same level, new SN = old SN + 1)
    // this helps ensuring audio continuity
    // and this also avoids audio glitches/cut when switching quality, or reporting wrong duration on first audio frame
    const timeOffsetMpegTS = timeOffset * inputTimeScale;
    this.isAudioContiguous = contiguous =
      contiguous ||
      ((inputSamples.length &&
        nextAudioPts > 0 &&
        ((accurateTimeOffset &&
          Math.abs(timeOffsetMpegTS - nextAudioPts) < 9000) ||
          Math.abs(
            normalizePts(inputSamples[0].pts - initPTS, timeOffsetMpegTS) -
              nextAudioPts
          ) <
            20 * inputSampleDuration)) as boolean);

    // compute normalized PTS
    inputSamples.forEach(function (sample) {
      sample.pts = normalizePts(sample.pts - initPTS, timeOffsetMpegTS);
    });

    if (!contiguous || nextAudioPts < 0) {
      // filter out sample with negative PTS that are not playable anyway
      // if we don't remove these negative samples, they will shift all audio samples forward.
      // leading to audio overlap between current / next fragment
      inputSamples = inputSamples.filter((sample) => sample.pts >= 0);

      // in case all samples have negative PTS, and have been filtered out, return now
      if (!inputSamples.length) {
        return;
      }

      if (videoTimeOffset === 0) {
        // Set the start to 0 to match video so that start gaps larger than inputSampleDuration are filled with silence
        nextAudioPts = 0;
      } else if (accurateTimeOffset) {
        // When not seeking, not live, and LevelDetails.PTSKnown, use fragment start as predicted next audio PTS
        nextAudioPts = Math.max(0, timeOffsetMpegTS);
      } else {
        // if frags are not contiguous and if we cant trust time offset, let's use first sample PTS as next audio PTS
        nextAudioPts = inputSamples[0].pts;
      }
    }

    // If the audio track is missing samples, the frames seem to get "left-shifted" within the
    // resulting mp4 segment, causing sync issues and leaving gaps at the end of the audio segment.
    // In an effort to prevent this from happening, we inject frames here where there are gaps.
    // When possible, we inject a silent frame; when that's not possible, we duplicate the last
    // frame.

    if (track.isAAC) {
      const alignedWithVideo = videoTimeOffset !== undefined;
      const maxAudioFramesDrift = this.config.maxAudioFramesDrift;
      for (let i = 0, nextPts = nextAudioPts; i < inputSamples.length; i++) {
        // First, let's see how far off this frame is from where we expect it to be
        const sample = inputSamples[i];
        const pts = sample.pts;
        const delta = pts - nextPts;
        const duration = Math.abs((1000 * delta) / inputTimeScale);

        // When remuxing with video, if we're overlapping by more than a duration, drop this sample to stay in sync
        if (
          delta <= -maxAudioFramesDrift * inputSampleDuration &&
          alignedWithVideo
        ) {
          if (i === 0) {
            logger.warn(
              `Audio frame @ ${(pts / inputTimeScale).toFixed(
                3
              )}s overlaps nextAudioPts by ${Math.round(
                (1000 * delta) / inputTimeScale
              )} ms.`
            );
            this.nextAudioPts = nextAudioPts = nextPts = pts;
          }
        } // eslint-disable-line brace-style

        // Insert missing frames if:
        // 1: We're more than maxAudioFramesDrift frame away
        // 2: Not more than MAX_SILENT_FRAME_DURATION away
        // 3: currentTime (aka nextPtsNorm) is not 0
        // 4: remuxing with video (videoTimeOffset !== undefined)
        else if (
          delta >= maxAudioFramesDrift * inputSampleDuration &&
          duration < MAX_SILENT_FRAME_DURATION &&
          alignedWithVideo
        ) {
          let missing = Math.round(delta / inputSampleDuration);
          // Adjust nextPts so that silent samples are aligned with media pts. This will prevent media samples from
          // later being shifted if nextPts is based on timeOffset and delta is not a multiple of inputSampleDuration.
          nextPts = pts - missing * inputSampleDuration;
          if (nextPts < 0) {
            missing--;
            nextPts += inputSampleDuration;
          }
          if (i === 0) {
            this.nextAudioPts = nextAudioPts = nextPts;
          }
          logger.warn(
            `[mp4-remuxer]: Injecting ${missing} audio frame @ ${(
              nextPts / inputTimeScale
            ).toFixed(3)}s due to ${Math.round(
              (1000 * delta) / inputTimeScale
            )} ms gap.`
          );
          for (let j = 0; j < missing; j++) {
            const newStamp = Math.max(nextPts as number, 0);
            let fillFrame = AAC.getSilentFrame(
              track.manifestCodec || track.codec,
              track.channelCount
            );
            if (!fillFrame) {
              logger.log(
                '[mp4-remuxer]: Unable to get silent frame for given audio codec; duplicating last frame instead.'
              );
              fillFrame = sample.unit.subarray();
            }
            inputSamples.splice(i, 0, {
              unit: fillFrame,
              pts: newStamp,
            });
            nextPts += inputSampleDuration;
            i++;
          }
        }
        sample.pts = nextPts;
        nextPts += inputSampleDuration;
      }
    }
    let firstPTS: number | null = null;
    let lastPTS: number | null = null;
    let mdat: any;
    let mdatSize: number = 0;
    let sampleLength: number = inputSamples.length;
    while (sampleLength--) {
      mdatSize += inputSamples[sampleLength].unit.byteLength;
    }
    for (let j = 0, nbSamples = inputSamples.length; j < nbSamples; j++) {
      const audioSample = inputSamples[j];
      const unit = audioSample.unit;
      let pts = audioSample.pts;
      if (lastPTS !== null) {
        // If we have more than one sample, set the duration of the sample to the "real" duration; the PTS diff with
        // the previous sample
        const prevSample = outputSamples[j - 1];
        prevSample.duration = Math.round((pts - lastPTS) / scaleFactor);
      } else {
        if (contiguous && track.isAAC) {
          // set PTS/DTS to expected PTS/DTS
          pts = nextAudioPts;
        }
        // remember first PTS of our audioSamples
        firstPTS = pts;
        if (mdatSize > 0) {
          /* concatenate the audio data and construct the mdat in place
            (need 8 more bytes to fill length and mdat type) */
          mdatSize += offset;
          try {
            mdat = new Uint8Array(mdatSize);
          } catch (err) {
            this.observer.emit(Events.ERROR, Events.ERROR, {
              type: ErrorTypes.MUX_ERROR,
              details: ErrorDetails.REMUX_ALLOC_ERROR,
              fatal: false,
              bytes: mdatSize,
              reason: `fail allocating audio mdat ${mdatSize}`,
            });
            return;
          }
          if (!rawMPEG) {
            const view = new DataView(mdat.buffer);
            view.setUint32(0, mdatSize);
            mdat.set(MP4.types.mdat, 4);
          }
        } else {
          // no audio samples
          return;
        }
      }
      mdat.set(unit, offset);
      const unitLen = unit.byteLength;
      offset += unitLen;
      // Default the sample's duration to the computed mp4SampleDuration, which will either be 1024 for AAC or 1152 for MPEG
      // In the case that we have 1 sample, this will be the duration. If we have more than one sample, the duration
      // becomes the PTS diff with the previous sample
      outputSamples.push(new Mp4Sample(true, mp4SampleDuration, unitLen, 0));
      lastPTS = pts;
    }

    // We could end up with no audio samples if all input samples were overlapping with the previously remuxed ones
    const nbSamples = outputSamples.length;
    if (!nbSamples) {
      return;
    }

    // The next audio sample PTS should be equal to last sample PTS + duration
    const lastSample = outputSamples[outputSamples.length - 1];
    this.nextAudioPts = nextAudioPts =
      lastPTS! + scaleFactor * lastSample.duration;

    // Set the track samples from inputSamples to outputSamples before remuxing
    const moof = rawMPEG
      ? new Uint8Array(0)
      : MP4.moof(
          track.sequenceNumber++,
          firstPTS! / scaleFactor,
          Object.assign({}, track, { samples: outputSamples })
        );

    // Clear the track samples. This also clears the samples array in the demuxer, since the reference is shared
    track.samples = [];
    const start = firstPTS! / inputTimeScale;
    const end = nextAudioPts / inputTimeScale;
    const type: SourceBufferName = 'audio';
    const audioData = {
      data1: moof,
      data2: mdat,
      startPTS: start,
      endPTS: end,
      startDTS: start,
      endDTS: end,
      type,
      hasAudio: true,
      hasVideo: false,
      nb: nbSamples,
    };

    this.isAudioContiguous = true;

    console.assert(mdat.length, 'MDAT length must not be zero');
    return audioData;
  }

  remuxEmptyAudio(
    track: DemuxedAudioTrack,
    timeOffset: number,
    contiguous: boolean,
    videoData: Fragment
  ): RemuxedTrack | undefined {
    const inputTimeScale: number = track.inputTimeScale;
    const mp4timeScale: number = track.samplerate
      ? track.samplerate
      : inputTimeScale;
    const scaleFactor: number = inputTimeScale / mp4timeScale;
    const nextAudioPts: number | null = this.nextAudioPts;
    // sync with video's timestamp
    const startDTS: number =
      (nextAudioPts !== null
        ? nextAudioPts
        : videoData.startDTS * inputTimeScale) + this._initDTS;
    const endDTS: number = videoData.endDTS * inputTimeScale + this._initDTS;
    // one sample's duration value
    const frameDuration: number = scaleFactor * AAC_SAMPLES_PER_FRAME;
    // samples count of this segment's duration
    const nbSamples: number = Math.ceil((endDTS - startDTS) / frameDuration);
    // silent frame
    const silentFrame: Uint8Array | undefined = AAC.getSilentFrame(
      track.manifestCodec || track.codec,
      track.channelCount
    );

    logger.warn('[mp4-remuxer]: remux empty Audio');
    // Can't remux if we can't generate a silent frame...
    if (!silentFrame) {
      logger.trace(
        '[mp4-remuxer]: Unable to remuxEmptyAudio since we were unable to get a silent frame for given audio codec'
      );
      return;
    }

    const samples: Array<any> = [];
    for (let i = 0; i < nbSamples; i++) {
      const stamp = startDTS + i * frameDuration;
      samples.push({ unit: silentFrame, pts: stamp, dts: stamp });
    }
    track.samples = samples;

    return this.remuxAudio(track, timeOffset, contiguous, false);
  }
}

export function normalizePts(value: number, reference: number | null): number {
  let offset;
  if (reference === null) {
    return value;
  }

  if (reference < value) {
    // - 2^33
    offset = -8589934592;
  } else {
    // + 2^33
    offset = 8589934592;
  }
  /* PTS is 33bit (from 0 to 2^33 -1)
    if diff between value and reference is bigger than half of the amplitude (2^32) then it means that
    PTS looping occured. fill the gap */
  while (Math.abs(value - reference) > 4294967296) {
    value += offset;
  }

  return value;
}

function findKeyframeIndex(samples: Array<AvcSample>): number {
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].key) {
      return i;
    }
  }
  return -1;
}

export function flushTextTrackMetadataCueSamples(
  track: DemuxedMetadataTrack,
  timeOffset: number,
  initPTS: number,
  initDTS: number
): RemuxedMetadata | undefined {
  const length = track.samples.length;
  if (!length) {
    return;
  }
  const inputTimeScale = track.inputTimeScale;
  for (let index = 0; index < length; index++) {
    const sample = track.samples[index];
    // setting id3 pts, dts to relative time
    // using this._initPTS and this._initDTS to calculate relative time
    sample.pts =
      normalizePts(sample.pts - initPTS, timeOffset * inputTimeScale) /
      inputTimeScale;
    sample.dts =
      normalizePts(sample.dts - initDTS, timeOffset * inputTimeScale) /
      inputTimeScale;
  }
  const samples = track.samples;
  track.samples = [];
  return {
    samples,
  };
}

export function flushTextTrackUserdataCueSamples(
  track: DemuxedUserdataTrack,
  timeOffset: number,
  initPTS: number
): RemuxedUserdata | undefined {
  const length = track.samples.length;
  if (!length) {
    return;
  }

  const inputTimeScale = track.inputTimeScale;
  for (let index = 0; index < length; index++) {
    const sample = track.samples[index];
    // setting text pts, dts to relative time
    // using this._initPTS and this._initDTS to calculate relative time
    sample.pts =
      normalizePts(sample.pts - initPTS, timeOffset * inputTimeScale) /
      inputTimeScale;
  }
  track.samples.sort((a, b) => a.pts - b.pts);
  const samples = track.samples;
  track.samples = [];
  return {
    samples,
  };
}

class Mp4Sample {
  public size: number;
  public duration: number;
  public cts: number;
  public flags: Mp4SampleFlags;

  constructor(isKeyframe: boolean, duration, size, cts) {
    this.duration = duration;
    this.size = size;
    this.cts = cts;
    this.flags = new Mp4SampleFlags(isKeyframe);
  }
}

class Mp4SampleFlags {
  public isLeading: 0 = 0;
  public isDependedOn: 0 = 0;
  public hasRedundancy: 0 = 0;
  public degradPrio: 0 = 0;
  public dependsOn: 1 | 2 = 1;
  public isNonSync: 0 | 1 = 1;

  constructor(isKeyframe) {
    this.dependsOn = isKeyframe ? 2 : 1;
    this.isNonSync = isKeyframe ? 0 : 1;
  }
}
