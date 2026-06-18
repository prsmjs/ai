#!/usr/bin/env node
import { compose, getOrCreateThread, Inherit, model, noToolsCalled, scope, setKeys } from "@prsm/ai";
import { getSystem } from "./system.js";
import {
  read_file,
  write_file,
  edit_file,
  delete_file,
  list_directory,
  glob,
  grep,
  bash,
} from "./tools.js";
import { createCli } from "./cli.js";

setKeys({ openai: process.env.OPENAI_API_KEY });

const thread = getOrCreateThread("code-agent");

const createWorkflow = (stream, approvalCallback, abortSignal) =>
  compose(
    scope(
      {
        inherit: Inherit.All,
        system: getSystem(),
        tools: [read_file, write_file, edit_file, delete_file, list_directory, glob, grep, bash],
        toolConfig: { requireApproval: true, approvalCallback },
        stream,
        until: noToolsCalled(),
      },
      (ctx) => model({ model: "openai/gpt-5.2" })({ ...ctx, abortSignal }),
    ),
  );

createCli(createWorkflow, thread);
