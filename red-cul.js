#!/usr/bin/env node
const axios = require("axios").default
const yaml = require("yaml")
const q = require("querystring")
const fs = require("fs")
const path = require("path")
const os = require("os")
const _execFile = require("child_process").execFile
const pkg = require("./package.json")
const BIN_PATH = `${process.env.HOME}/.local/bin`
const FormData = require("form-data")
const yargs = require('yargs');

const argv = yargs.usage("Usage: $0 [OPTIONS] flac-dir [flac-dir2, [...]]")

.option("api-key", {
  describe: "API token with Torrents capability. Can definable in env as RED_API_KEY",
}).option("announce", {
  alias: "a",
  describe: "Specify the full announce URL found on https://redacted.ch/upload.php",
  demandOption: true,
  // maybe we can retrieve this from the api instead.
})
  .option("transcode-dir", {
  alias: "t",
  describe: "Output directory of transcodes (e.g. ~/my_music)",
  default: process.env.HOME || process.env.HOMEPATH,
  demandOption: true, // TODO: same dir as input by default
}).option("torrent-dir", {
  alias: "o",
  describe: "Where to output torrent files",
  default: process.env.HOME || process.env.HOMEPATH,
  demandOption: true
}).help('h').alias('h','help').argv

// input dirs
const dirs = argv._

const nproc = os.cpus().length

// API_KEY requires 'Torrents' permission.
const API_KEY = argv['api-key'] || process.env.RED_API_KEY
if (!API_KEY) {
  console.error("Missing required argument '--api-key'")
  process.exit(1)
}

const ANNOUNCE_URL = argv['announce'];

// Transcodes end here
const TRANSCODE_DIR = argv['transcode-dir']
if (!fs.statSync(TRANSCODE_DIR, { throwIfNoEntry: false })) {
  console.error(
    `${TRANSCODE_DIR} does not exist! Please create it.`
  )
  process.exit(1)
}

// Ready torrents end here (rtorrent watches this dir and auto adds torrents)
const TORRENT_DIR = argv['torrent-dir']
if (!fs.statSync(TORRENT_DIR, { throwIfNoEntry: false })) {
  console.error(
    `${TORRENT_DIR} does not exist! Please create it.`
  )
  process.exit(1)
}

const FLAC2MP3_PATH = process.env.FLAC2MP3 || `${__dirname}/flac2mp3/flac2mp3.pl`

const HTTP_AUTHZ_HEADERS = {
  Authorization: API_KEY,
  "user-agent": `${pkg.name}@${pkg.version}`,
}

const sanitizeFilename = (filename) =>
  filename
    .replace(/\//g, "∕")
    .replace(/^~/, "")
    .replace(/\.$/g, "_")
    .replace(/[\x01-\x1f]/g, "_")
    .replace(/[<>:"?*|]/g, "_")
    .trim()

function execFile(cmd, args, mute) {
  return new Promise((resolve, reject) => {
    const childProc = _execFile(cmd, args)
    const prefix = `>> [${childProc.pid}] `
    const prefixErr = `!! [${childProc.pid}] `
    let stdout = ""
    let stderr = ""
    childProc.stdout.on("data", (d) => {
      stdout += d
      if (mute) return
      process.stdout.write(prefix + d)
    })
    childProc.stderr.on("data", (d) => {
      stderr += d
      if (mute) return
      process.stderr.write(prefixErr + d)
    })
    childProc.on("exit", (code) => {
      if (code !== 0) {
        console.error(`cmd failed: ${cmd} ${args.join(" ")}`)
        reject({ stdout, stderr })
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// Copy additional (non-music) files too. Only moving png and jpegs right now,
// anything else missing?
async function copyOtherFiles(inDir, outDir) {
  const files = await fs.promises.readdir(inDir)
  return Promise.all(
    files
      .filter((f) => /\.(jpe?g|png)$/.test(f))
      .map((file) =>
        fs.promises.copyFile(`${inDir}/${file}`, `${outDir}/${file}`)
      )
  )
}

async function makeFlacTranscode(outDir, inDir, sampleRate) {
  console.log(`FLAC transcode ${inDir} -> ${outDir}`)
  try {
    await fs.promises.mkdir(outDir)
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err
    }
  }
  const files = await fs.promises.readdir(inDir)

  for (const file of files) {
    if (!/\.flac$/.test(file)) {
      const stats = await fs.promises.lstat(`${inDir}/${file}`)
      if (stats.isDirectory()) {
        await makeFlacTranscode(
          `${outDir}/${file}`,
          `${inDir}/${file}`,
          sampleRate
        )
      }
    } else {
      console.log(`Transcoding ${file}...`)
      await execFile("sox", [
        "--multi-threaded",
        "--buffer=131072",
        "-G",
        `${inDir}/${file}`,
        "-b16",
        `${outDir}/${file}`,
        "rate",
        "-v",
        "-L",
        `${sampleRate}`,
        "dither",
      ])
    }
  }
  await copyOtherFiles(inDir, outDir)
  return {
    method: `sox -G input.flac -b16 output.flac rate -v -L ${sampleRate} dither`,
  }
}

async function makeMp3Transcode(outDir, inDir, preset) {
  console.log("transcoding", preset)

  await execFile(FLAC2MP3_PATH, [
    `--preset=${preset}`,
    `--processes=${nproc}`,
    inDir,
    outDir,
  ])
  await copyOtherFiles(inDir, outDir)
  return {
    method: `flac2mp3 --preset=${preset}`,
  }
}

async function probeMediaFile(path) {
  const { stdout } = await execFile(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-show_streams",
      "-show_format",
      "-print_format",
      "json",
      path,
    ],
    true
  )
  return JSON.parse(stdout)
}

function getBitrate(probeInfo) {
  const flacStream = probeInfo.streams.find(
    ({ codec_name }) => codec_name === "flac"
  )
  return Number.parseInt(flacStream.bits_per_raw_sample, 10)
}

const RED_API = "https://redacted.ch/ajax.php"

async function torrentgroup({ hash }) {
  const resp = await axios.get(
    `${RED_API}?${q.encode({
      action: "torrentgroup",
      hash,
    })}`,
    {
      validateStatus: (status) => status < 500,
      headers: HTTP_AUTHZ_HEADERS,
    }
  )

  if (resp.data.status !== "success") {
    throw new Error(`getTorrentGroup: ${resp.data.status}`)
  }

  return resp.data.response
}

async function upload(opts) {
  const form = new FormData()

  for (const [k, v] of Object.entries(opts)) {
    if (v) {
      if (Array.isArray(v)) {
        for (const el of v) {
          form.append(`${k}[]`, el)
        }
      } else {
        form.append(k, v)
      }
    }
  }
  const { extra_file_1, extra_file_2, file_input, ...rest } = opts
  console.log(rest)

  const resp = await axios.post(`${RED_API}?action=upload`, form, {
    headers: {
      ...HTTP_AUTHZ_HEADERS,
      ...form.getHeaders(),
    },
  })

  if (resp.data.status !== "success") {
    throw new Error(`getTorrentGroup: ${resp.data.status}`)
  }

  return resp.data.response
}

const filterSameEditionGroupAs = ({
  media,
  remasterTitle,
  remasterCatalogueNumber,
  remasterYear,
  remasterRecordLabel,
}) =>
  function filterSameEdition(torrent) {
    // if nothing else given, all torrents are included in the editionGroup
    let result = true

    // if not same media, be gone!
    result &= torrent.media === media

    if (remasterTitle) {
      // for the rest, just filter if available
      result &= torrent.remasterTitle === remasterTitle
    }
    if (remasterCatalogueNumber) {
      result &= torrent.remasterCatalogueNumber === remasterCatalogueNumber
    }
    if (remasterRecordLabel) {
      result &= torrent.remasterRecordLabel === remasterRecordLabel
    }
    if (remasterYear) {
      result &= torrent.remasterYear === remasterYear
    }
    return result
  }

const toCamelCase = (str) =>
  str
    .split(" ")
    .map((word) => word.toLowerCase().replace(/^./, (c) => c.toUpperCase()))
    .join("")
    .replace(/^./, (c) => c.toLowerCase())

async function getOrigin(originPath) {
  const origin = await fs.promises.readFile(originPath)
  const parsed = yaml.parse(origin.toString("utf-8"))

  // parse and transform object keys, eg. o["Edition Year"] -> o.editionYear
  return Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [toCamelCase(k), v])
  )
}

// get the sample rate of this release or return false if the sample rates are
// bad (inconsistent or too low)
function getConsistentSampleRate(probeInfos) {
  let currentRate = null
  for (const probeInfo of probeInfos) {
    const flacStream = probeInfo.streams.find(
      ({ codec_name }) => codec_name === "flac"
    )
    const srcSampleRate = Number.parseInt(flacStream.sample_rate, 10)
    if (!currentRate) {
      currentRate = srcSampleRate
    } else if (currentRate !== srcSampleRate) {
      console.warn(
        `Inconsistent sample rates, ${currentRate} vs ${srcSampleRate}`
      )
      return false
    } else if (srcSampleRate < 44100) {
      console.warn(`Sample rates below minimum, ${srcSampleRate}`)
      return false
    }
  }
  return currentRate
}

function requiredTagsPresent(probeInfos) {
  return probeInfos.some((pi) => {
    // {
    //             "TITLE": "Pointbreak",
    //             "ARTIST": "Vanilla",
    //             "DATE": "2021",
    //             "COMMENT": "Visit https://vanillabeats.bandcamp.com",
    //             "ALBUM": "Pointbreak",
    //             "track": "1",
    //             "album_artist": "Vanilla",
    //             "ISRC": "USEAX2100015"
    //         }
    // ffprobe bad. tags are lowercased at random.
    // maybe use mediainfo instead.
    const tags = Object.keys(pi.format.tags).map((key) => key.toUpperCase())
    return ["TITLE", "ARTIST", "ALBUM", "TRACK"].every((t) => tags.includes(t))
  })
}

async function mktorrent(targetDir, torrentPath) {
  return execFile(`mktorrent`, [
    '--piece-length=20', // 1MiB chunk size
    '--private',
    '-source=RED',
    `--announce=${ANNOUNCE_URL}`,
    targetDir,
    `--output=${torrentPath}`
  ])
}

async function main(inputDir) {
  const origin = await getOrigin(`${inputDir}/origin.yaml`)

  if (origin.format !== "FLAC") {
    console.log("not a flac, not interested")
    return
  }

  const torrentGroup = await torrentgroup({ hash: origin.infoHash })

  const editionInfo = {
    media: origin.media,
    remasterTitle: origin.edition,
    remasterCatalogueNumber: origin.catalogNumber,
    remasterYear: origin.editionYear || origin.originalYear,
    remasterRecordLabel: origin.recordLabel,
  }
  console.log("hash:", origin.infoHash)
  console.log("permalink:", origin.permalink)
  console.log(editionInfo)

  const editionGroup = torrentGroup.torrents.filter(
    filterSameEditionGroupAs(editionInfo)
  )

  const probeInfos = await Promise.all(
    origin.files
      .map(({ Name }) => Name)
      .filter((name) => /\.flac$/.test(name))
      .map((name) => `${inputDir}/${name}`)
      .map(probeMediaFile)
  )

  if (!requiredTagsPresent(probeInfos)) {
    console.error(`[!] Required tags are not present! check ${inputDir}`)
    return
  }
  console.log("[+] Required tags are present, would transcode this")

  const hasFLAC16 = editionGroup.some(
    (torrent) => torrent.encoding === "Lossless"
  )
  const originIsFLAC24 = origin.encoding === "24bit Lossless"

  const files = []
  const releaseDescBase = `Source: ${origin.permalink}.`

  // will make dirs for FLAC, V0 and 320 transcodes using this as base
  let outputDirBase = `${TRANSCODE_DIR}/${sanitizeFilename(
    `${origin.artist} - ${origin.name}`
  )}`
  const year = editionInfo.remasterYear || origin.originalYear
  if (editionInfo.remasterTitle) {
    // e.g., "Special Edition"
    outputDirBase += ` (${editionInfo.remasterTitle})`
  }

  if (year) {
    // can neither remasterYear nor originalYear ever be present?
    outputDirBase += ` (${year})`
  }
  outputDirBase += ` - ${origin.media}`

  if (!hasFLAC16 && originIsFLAC24) {
    const outputDir = `${outputDirBase} FLAC`

    const badBitRate = probeInfos.filter(
      (probeInfo) => getBitrate(probeInfo) !== 24
    )
    if (badBitRate.length > 0) {
      console.error(
        `These are not 24bit flac. Found ${badBitRate
          .map(getBitrate)
          .join(",")}-bit too. Won't transcode this to flac16`
      )
    } else {
      const inputSampleRate = getConsistentSampleRate(probeInfos)
      if (!inputSampleRate) {
        console.error(`[!] Inconsistent sample rate! check ${inputDir}`)
      } else {
        const sampleRate = inputSampleRate % 48000 === 0 ? 48000 : 44100
        const { method } = await makeFlacTranscode(
          outputDir,
          inputDir,
          sampleRate
        )
        const torrentPath=`${TORRENT_DIR}/${path.basename(outputDir)}.torrent`
        await mktorrent(outputDir, torrentPath)
        files.push({
          format: "FLAC",
          bitrate: "Lossless",
          torrentPath,
          release_desc: `${releaseDescBase} Method: ${method}`,
        })
      }
    }
  }

  for (const [preset, bitrate] of [
    ["V0", "V0 (VBR)"],
    ["320", "320"],
  ]) {
    if (!editionGroup.some((torrent) => torrent.encoding === bitrate)) {
      const outputDir = `${outputDirBase} ${preset}`
      const { method } = await makeMp3Transcode(outputDir, inputDir, preset)
      const torrentPath=`${TORRENT_DIR}/${path.basename(outputDir)}.torrent`
      await mktorrent(outputDir, torrentPath)

      files.push({
        format: "MP3",
        bitrate,
        torrentPath: `${TORRENT_DIR}/${path.basename(outputDir)}.torrent`,
        release_desc: `${releaseDescBase} Method: ${method}`,
      })
    }
  }

  if (files.length === 0) {
    console.log("no files made")
    return
  }

  const { torrentPath, bitrate, format, release_desc } = files[0]

  const uploadOpts = {
    groupid: torrentGroup.group.id,
    unknown: false, // can this be true?
    remaster_year: editionInfo.remasterYear,
    remaster_title: editionInfo.remasterTitle,
    remaster_record_label: editionInfo.remasterRecordLabel,
    remaster_catalogue_number: editionInfo.remasterCatalogueNumber,
    scene: false,
    media: origin.media,

    file_input: fs.createReadStream(torrentPath),
    bitrate,
    format,
    release_desc,
  }

  if (files[1]) {
    const { torrentPath, bitrate, format, release_desc } = files[1]
    uploadOpts.extra_file_1 = fs.createReadStream(torrentPath)
    uploadOpts.extra_format = [format]
    uploadOpts.extra_bitrate = [bitrate]
    uploadOpts.extra_release_desc = [release_desc]
  }

  if (files[2]) {
    const { torrentPath, bitrate, format, release_desc } = files[2]
    uploadOpts.extra_file_2 = fs.createReadStream(torrentPath)
    uploadOpts.extra_format.push(format)
    uploadOpts.extra_bitrate.push(bitrate)
    uploadOpts.extra_release_desc.push(release_desc)
  }

  const data = await upload(uploadOpts)
  console.log("Done!")
  console.log(data)
}

;(async () => {
  for (const dir of dirs) {
    await main(dir.replace(/\/$/, "")).catch(console.error)
  }
})()
