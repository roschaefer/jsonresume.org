const sampleResume = require("./samples/resume");
const find = require("lodash/find");
const axios = require("axios");
const Validator = require("jsonschema").Validator;
import schema from "./schema";
import qr from "./formatters/qr";
import template from "./formatters/template";
import txt from "./formatters/text";
import tex from "./formatters/tex";
import json from "./formatters/json";
import yaml from "./formatters/yaml";

const { Client } = require("pg");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const FILE_TYPES = new Set(["qr", "json", "tex", "txt", "template", "yaml"]);

const failMessage = (message) => {
  return (
    message +
    ", message @ajaxdavis on twitter if you need help (or tag me in your gist comments @thomasdavis"
  );
};

export default async function handler(req, res) {
  const { theme, payload } = req.query;
  const v = new Validator();
  const payloadSplit = payload.split(".");

  const username = payloadSplit[0];
  let fileType = "template";
  if (payloadSplit.length === 2) {
    fileType = payloadSplit[1];
  }

  if (!FILE_TYPES.has(fileType)) {
    return res.status(200).send(failMessage("not supported file type"));
  }

  const FORMATTERS = {
    qr,
    json,
    tex,
    txt,
    template,
    yaml,
  };

  const formatter = FORMATTERS[fileType];

  if (!formatter) {
    return res.status(200).send(failMessage("not supported formatted"));
  }

  if (
    [
      "favicon.ico",
      "competition",
      "stats",
      "apple-touch-icon.png",
      "apple-touch-icon-precomposed.png",
      "robots.txt",
    ].indexOf(username) !== -1
  ) {
    return res.send(null);
  }

  let gistId;
  console.log("Fetching gistId");
  console.log(`https://api.github.com/users/${username}/gists`);

  let gistData = {};

  try {
    gistData = await axios.get(
      `https://api.github.com/users/${username}/gists?per_page=100`,
      {
        headers: {
          Authorization: "Bearer " + GITHUB_TOKEN,
        },
      }
    );
  } catch (e) {
    console.log(e);
    return res.send(failMessage("This is not a valid Github username"));
  }

  if (!gistData.data) {
    return res.send(failMessage("This is not a valid Github username"));
  }

  const resumeUrl = find(gistData.data, (f) => {
    return f.files["resume.json"];
  });

  if (!resumeUrl) {
    return res.send(
      failMessage("You have no gists named resume.json or your gist is private")
    );
  }

  gistId = resumeUrl.id;

  let resumeRes = {};

  try {
    const fullResumeGistUrl =
      `https://gist.githubusercontent.com/${username}/${gistId}/raw?cachebust=` +
      new Date().getTime();

    resumeRes = await axios({
      method: "GET",
      headers: { "content-type": "application/json" },
      url: fullResumeGistUrl,
    });
  } catch (e) {
    // If gist url is invalid, flush the gistid in cache
    return res.status(200).send(failMessage("Cannot fetch gist, no idea why"));
  }

  let realTheme =
    theme || (resumeRes.data.meta && resumeRes.data.meta.theme) || "flat";

  realTheme = realTheme.toLowerCase();

  const selectedResume = resumeRes?.data ?? sampleResume;
  const validation = v.validate(selectedResume, schema);

  if (!validation.valid) {
    return res.status(200).send(
      failMessage("Validation failed") +
        `
    
Your resume does not conform to the schema, visit https://jsonresume.org/schema/ to double check why. But the error message below should contain all the information you need.

=====

${JSON.stringify(validation.errors, null, 2)}

=====
    `
    );
  }

  const client = new Client(process.env.DATABASE_URL_RAW);

  // @todo - using as a resume cache for extra features
  (async () => {
    await client.connect();
    try {
      const results = await client.query(
        `INSERT INTO resumes (username, resume) VALUES ($1, $2)
        ON CONFLICT (username) 
        DO 
          UPDATE SET resume = $2`,
        [username, JSON.stringify(selectedResume)]
      );
    } catch (err) {
      console.error("error executing query:", err);
    } finally {
      client.end();
    }
  })();

  const options = { ...req.query, theme: realTheme, username };
  let formatted = "";
  try {
    formatted = await formatter.format(selectedResume, options);
  } catch (e) {
    console.log(e);
    return res
      .status(200)
      .send(
        failMessage(
          "Cannot format resume, no idea why #likely-a-validation-error"
        )
      );
  }

  formatted.headers.forEach((header) => {
    res.setHeader(header.key, header.value);
  });

  if (formatted.content instanceof Buffer) {
    // handles images/binary
    formatted.content.pipe(res);
  } else {
    return res.status(200).send(formatted.content);
  }
}
