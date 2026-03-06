package attachments

import (
	"encoding/binary"
	"fmt"
	"io"
	"math/rand"
	"os"
)

const maxAudioAmps = 60

// containerBoxes lists MP4 box types that contain child boxes.
var containerBoxes = map[string]bool{
	"moov": true, "trak": true, "mdia": true,
	"minf": true, "stbl": true, "udta": true,
	"edts": true,
}

type boxVisitor func(path string, r io.ReadSeeker, payloadSize int64) error

// ParseMP4Audio extracts duration (ms) and approximate waveform amplitudes
// from an MP4/M4A file. Duration comes from the moov/mvhd atom. Waveform
// amplitudes are derived from per-frame compressed sizes in the stsz atom -
// larger compressed frames correlate with louder audio, giving a rough
// amplitude envelope without any audio decoding.
func ParseMP4Audio(filename string) (durationMs int, amps []float64, err error) {
	f, err := os.Open(filename)
	if err != nil {
		return 0, nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return 0, nil, err
	}

	var timescale uint32
	var duration uint64
	var frameSizes []uint32

	err = walkMP4Boxes(f, 0, fi.Size(), "", func(path string, r io.ReadSeeker, size int64) error {
		switch path {
		case "moov.mvhd":
			ts, dur, e := parseMvhd(r)
			if e != nil {
				return e
			}
			timescale = ts
			duration = dur
		case "moov.trak.mdia.minf.stbl.stsz":
			fs, e := parseStsz(r)
			if e != nil {
				return e
			}
			if frameSizes == nil {
				frameSizes = fs
			}
		}
		return nil
	})
	if err != nil {
		return 0, nil, err
	}

	if timescale == 0 {
		return 0, nil, fmt.Errorf("mvhd atom not found in %s", filename)
	}
	durationMs = int((duration * 1000) / uint64(timescale))
	amps = frameSizesToAmps(frameSizes, maxAudioAmps)
	return durationMs, amps, nil
}

// walkMP4Boxes iterates over MP4 boxes at the given level, descending into
// known container boxes and calling visit for each box encountered.
func walkMP4Boxes(r io.ReadSeeker, offset, end int64, prefix string, visit boxVisitor) error {
	for offset < end {
		if _, err := r.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		var hdr [8]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil
			}
			return err
		}
		boxSize := int64(binary.BigEndian.Uint32(hdr[0:4]))
		boxType := string(hdr[4:8])
		headerSize := int64(8)

		if boxSize == 1 {
			var ext [8]byte
			if _, err := io.ReadFull(r, ext[:]); err != nil {
				return err
			}
			boxSize = int64(binary.BigEndian.Uint64(ext[:]))
			headerSize = 16
		} else if boxSize == 0 {
			boxSize = end - offset
		}

		if boxSize < headerSize {
			return fmt.Errorf("invalid MP4 box size %d for type %q", boxSize, boxType)
		}

		payloadStart := offset + headerSize
		payloadSize := boxSize - headerSize
		path := prefix + boxType

		if containerBoxes[boxType] {
			if err := walkMP4Boxes(r, payloadStart, payloadStart+payloadSize, path+".", visit); err != nil {
				return err
			}
		} else {
			if _, err := r.Seek(payloadStart, io.SeekStart); err != nil {
				return err
			}
			if err := visit(path, r, payloadSize); err != nil {
				return err
			}
		}

		offset += boxSize
	}
	return nil
}

// parseMvhd reads the movie header atom to extract timescale and duration.
func parseMvhd(r io.Reader) (timescale uint32, duration uint64, err error) {
	var vf [4]byte // version (1) + flags (3)
	if _, err = io.ReadFull(r, vf[:]); err != nil {
		return
	}
	version := vf[0]

	if version == 0 {
		var fields [16]byte // created(4) + modified(4) + timescale(4) + duration(4)
		if _, err = io.ReadFull(r, fields[:]); err != nil {
			return
		}
		timescale = binary.BigEndian.Uint32(fields[8:12])
		duration = uint64(binary.BigEndian.Uint32(fields[12:16]))
	} else {
		var fields [24]byte // created(8) + modified(8) + timescale(4) + duration(8)
		if _, err = io.ReadFull(r, fields[:]); err != nil {
			return
		}
		timescale = binary.BigEndian.Uint32(fields[16:20])
		duration = binary.BigEndian.Uint64(fields[20:28])
	}

	// Sanity check: timescale 0 would cause division by zero.
	if timescale == 0 {
		err = fmt.Errorf("mvhd timescale is 0")
	}
	return
}

// parseStsz reads the sample size atom to get per-frame byte sizes.
func parseStsz(r io.Reader) ([]uint32, error) {
	var buf [12]byte // version(1) + flags(3) + default_size(4) + count(4)
	if _, err := io.ReadFull(r, buf[:]); err != nil {
		return nil, err
	}
	defaultSize := binary.BigEndian.Uint32(buf[4:8])
	sampleCount := binary.BigEndian.Uint32(buf[8:12])

	if sampleCount == 0 || sampleCount > 10_000_000 {
		return nil, nil
	}

	sizes := make([]uint32, sampleCount)
	if defaultSize != 0 {
		// CBR: all frames the same size, waveform will be flat.
		for i := range sizes {
			sizes[i] = defaultSize
		}
		return sizes, nil
	}

	for i := uint32(0); i < sampleCount; i++ {
		if err := binary.Read(r, binary.BigEndian, &sizes[i]); err != nil {
			return nil, err
		}
	}
	return sizes, nil
}

// frameSizesToAmps converts raw compressed frame sizes into n normalized
// amplitude values in [0.0, 1.0]. Larger frames indicate louder audio.
func frameSizesToAmps(sizes []uint32, n int) []float64 {
	if len(sizes) == 0 {
		return nil
	}
	if n > len(sizes) {
		n = len(sizes)
	}

	amps := make([]float64, n)
	bucketSize := float64(len(sizes)) / float64(n)
	for i := 0; i < n; i++ {
		start := int(float64(i) * bucketSize)
		end := int(float64(i+1) * bucketSize)
		if end > len(sizes) {
			end = len(sizes)
		}
		var sum float64
		count := end - start
		if count == 0 {
			continue
		}
		for j := start; j < end; j++ {
			sum += float64(sizes[j])
		}
		amps[i] = sum / float64(count)
	}

	// Normalize to [0.0, 1.0] relative to peak.
	var maxAmp float64
	for _, a := range amps {
		if a > maxAmp {
			maxAmp = a
		}
	}
	if maxAmp > 0 {
		for i := range amps {
			amps[i] /= maxAmp
		}
	}

	return amps
}

// GenerateRandomAmps creates n random amplitude values in [0.2, 0.8] as a
// fallback waveform for audio files whose format cannot be parsed.
func GenerateRandomAmps(n int) []float64 {
	amps := make([]float64, n)
	for i := range amps {
		amps[i] = 0.2 + rand.Float64()*0.6
	}
	return amps
}
