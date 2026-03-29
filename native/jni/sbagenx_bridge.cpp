#include <jni.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

extern "C" {
#include "sbagenxlib.h"
}

namespace {

constexpr const char *kBridgeVersion = "0.4.0";

struct CurveParameterSnapshot {
  std::string name;
  double value = 0.0;
};

struct CurveInspection {
  bool available = false;
  SbxCurveInfo info{};
  std::vector<CurveParameterSnapshot> parameters;
};

std::string escape_json(const std::string &input) {
  std::string out;
  out.reserve(input.size() + 16U);

  for (unsigned char ch : input) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (ch < 0x20U) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
          out += buf;
        } else {
          out.push_back(static_cast<char>(ch));
        }
        break;
    }
  }

  return out;
}

std::string jstring_to_utf8(JNIEnv *env, jstring value) {
  if (!value) {
    return {};
  }

  const char *chars = env->GetStringUTFChars(value, nullptr);
  if (!chars) {
    return {};
  }

  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jstring to_jstring(JNIEnv *env, const std::string &value) {
  return env->NewStringUTF(value.c_str());
}

const char *status_text(int status) {
  const char *text = sbx_status_string(status);
  return text ? text : "unknown";
}

void append_diagnostics_json(std::ostringstream &json,
                             const SbxDiagnostic *diags,
                             size_t count) {
  json << '[';

  for (size_t index = 0; index < count; ++index) {
    const SbxDiagnostic &diag = diags[index];
    if (index > 0U) {
      json << ',';
    }

    json << '{'
         << "\"severity\":\""
         << (diag.severity == SBX_DIAG_WARNING ? "warning" : "error")
         << "\","
         << "\"code\":\"" << escape_json(diag.code) << "\","
         << "\"line\":" << diag.line << ','
         << "\"column\":" << diag.column << ','
         << "\"endLine\":" << diag.end_line << ','
         << "\"endColumn\":" << diag.end_column << ','
         << "\"message\":\"" << escape_json(diag.message) << "\""
         << '}';
  }

  json << ']';
}

void append_curve_parameters_json(
    std::ostringstream &json,
    const std::vector<CurveParameterSnapshot> &parameters) {
  json << '[';

  for (size_t index = 0; index < parameters.size(); ++index) {
    const CurveParameterSnapshot &parameter = parameters[index];
    if (index > 0U) {
      json << ',';
    }

    json << '{'
         << "\"name\":\"" << escape_json(parameter.name) << "\","
         << "\"value\":" << parameter.value
         << '}';
  }

  json << ']';
}

void append_curve_info_json(std::ostringstream &json,
                            const CurveInspection &inspection) {
  const SbxCurveInfo &info = inspection.info;

  json << '{'
       << "\"parameterCount\":" << info.parameter_count << ','
       << "\"hasSolve\":" << (info.has_solve ? "true" : "false") << ','
       << "\"hasCarrierExpr\":"
       << (info.has_carrier_expr ? "true" : "false") << ','
       << "\"hasAmpExpr\":" << (info.has_amp_expr ? "true" : "false") << ','
       << "\"hasMixampExpr\":"
       << (info.has_mixamp_expr ? "true" : "false") << ','
       << "\"beatPieceCount\":" << info.beat_piece_count << ','
       << "\"carrierPieceCount\":" << info.carrier_piece_count << ','
       << "\"ampPieceCount\":" << info.amp_piece_count << ','
       << "\"mixampPieceCount\":" << info.mixamp_piece_count << ','
       << "\"parameters\":";
  append_curve_parameters_json(json, inspection.parameters);
  json << '}';
}

void append_float_array_json(std::ostringstream &json,
                             const float *values,
                             size_t count) {
  json << '[';
  for (size_t index = 0; index < count; ++index) {
    if (index > 0U) {
      json << ',';
    }
    json << values[index];
  }
  json << ']';
}

float clamp_unit_float(double value) {
  if (value > 1.0) {
    return 1.0f;
  }
  if (value < -1.0) {
    return -1.0f;
  }
  return static_cast<float>(value);
}

struct ContextDeleter {
  void operator()(SbxContext *ctx) const {
    if (ctx) {
      sbx_context_destroy(ctx);
    }
  }
};

struct CurveDeleter {
  void operator()(SbxCurveProgram *curve) const {
    if (curve) {
      sbx_curve_destroy(curve);
    }
  }
};

struct SafeSeqPreparedText {
  SafeSeqPreparedText() {
    sbx_default_safe_seqfile_preamble(&config);
  }

  ~SafeSeqPreparedText() {
    if (prepared_text) {
      std::free(prepared_text);
    }
    sbx_free_safe_seqfile_preamble(&config);
  }

  char *prepared_text = nullptr;
  SbxSafeSeqfilePreamble config{};
};

int parse_safe_sbg_text(const std::string &text,
                        SafeSeqPreparedText *out,
                        std::string *out_error) {
  if (!out) {
    return SBX_EINVAL;
  }

  char errbuf[512];
  errbuf[0] = '\0';

  const int status = sbx_prepare_safe_seq_text(text.c_str(),
                                               &out->prepared_text,
                                               &out->config,
                                               errbuf,
                                               sizeof(errbuf));
  if (status != SBX_OK && out_error) {
    *out_error = errbuf[0] ? errbuf : "Failed to parse .sbg text.";
  }

  return status;
}

std::string build_sbg_runtime_config_json(int status,
                                          const std::string &source_name,
                                          double sample_rate,
                                          const std::string &mix_path,
                                          const std::string &error) {
  std::ostringstream json;
  json << '{'
       << "\"status\":" << status << ','
       << "\"statusText\":\"" << escape_json(status_text(status)) << "\","
       << "\"prepared\":false,"
       << "\"sampleRate\":" << sample_rate << ','
       << "\"channels\":2,"
       << "\"timeSec\":0.0,"
       << "\"durationSec\":0.0,"
       << "\"sourceName\":\"" << escape_json(source_name) << "\","
       << "\"mixPath\":\"" << escape_json(mix_path) << "\","
       << "\"error\":\"" << escape_json(error) << "\""
       << '}';
  return json.str();
}

class BridgeRuntimeState {
 public:
  BridgeRuntimeState() {
    sbx_default_engine_config(&config_);
  }

  std::string prepare_sbg_context(const std::string &text,
                                  const std::string &source_name,
                                  const int16_t *mix_samples,
                                  size_t mix_sample_count,
                                  const std::string &mix_source_name,
                                  bool mix_looping) {
    std::lock_guard<std::mutex> lock(mutex_);

    clear_locked();
    source_name_ = source_name.empty() ? "scratch.sbg" : source_name;

    SafeSeqPreparedText prepared;
    std::string parse_error;
    const int parse_status = parse_safe_sbg_text(text, &prepared, &parse_error);
    if (parse_status != SBX_OK) {
      clear_locked();
      return build_context_state_json_locked(parse_status, parse_error);
    }

    sbx_default_engine_config(&config_);
    if (prepared.config.have_r) {
      config_.sample_rate = static_cast<double>(prepared.config.rate);
    }

    const bool mix_required =
        prepared.config.mix_path && prepared.config.mix_path[0];
    const std::string requested_mix_path =
        mix_required ? prepared.config.mix_path : "";
    if (mix_required && (!mix_samples || mix_sample_count < 2U)) {
      clear_locked();
      mix_path_ = requested_mix_path;
      return build_context_state_json_locked(
          SBX_EINVAL,
          "This .sbg declares a mix input (-m), but no decoded mix stream was supplied.");
    }

    SbxContext *raw_ctx = sbx_context_create(&config_);
    if (!raw_ctx) {
      return build_context_state_json_locked(SBX_ENOMEM,
                                             "Failed to create SbxContext.");
    }

    std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);

    int status = SBX_OK;
    if (prepared.config.have_w) {
      status =
          sbx_context_set_default_waveform(next_ctx.get(), prepared.config.waveform);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        clear_locked();
        return build_context_state_json_locked(
            status,
            error && error[0] ? error
                              : "Failed to apply default waveform override.");
      }
    }

    if (prepared.config.have_I) {
      status = sbx_context_set_sequence_iso_override(next_ctx.get(),
                                                     &prepared.config.iso_env);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        clear_locked();
        return build_context_state_json_locked(
            status,
            error && error[0]
                ? error
                : "Failed to apply sequence isochronic envelope override.");
      }
    }

    if (prepared.config.have_H) {
      status = sbx_context_set_sequence_mixam_override(next_ctx.get(),
                                                       &prepared.config.mixam_env);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        clear_locked();
        return build_context_state_json_locked(
            status,
            error && error[0]
                ? error
                : "Failed to apply sequence mixam envelope override.");
      }
    }

    if (prepared.config.have_c) {
      status =
          sbx_context_set_amp_adjust(next_ctx.get(), &prepared.config.amp_adjust);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        clear_locked();
        return build_context_state_json_locked(
            status,
            error && error[0]
                ? error
                : "Failed to apply runtime amplitude-adjust profile.");
      }
    }

    status = sbx_context_load_sbg_timing_text(next_ctx.get(),
                                              prepared.prepared_text,
                                              0);
    if (status != SBX_OK) {
      const char *error = sbx_context_last_error(next_ctx.get());
      clear_locked();
      return build_context_state_json_locked(
          status, error && error[0] ? error : "Failed to load .sbg text.");
    }

    if (prepared.config.have_A) {
      SbxMixModSpec mix_mod = prepared.config.mix_mod;
      const double duration_sec = sbx_context_duration_sec(next_ctx.get());
      mix_mod.active = 1;
      if (mix_mod.main_len_sec <= 0.0) {
        mix_mod.main_len_sec = duration_sec > 0.0 ? duration_sec : 1.0;
      }
      if (mix_mod.wake_len_sec < 0.0) {
        mix_mod.wake_len_sec = 0.0;
      }
      status = sbx_context_set_mix_mod(next_ctx.get(), &mix_mod);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        clear_locked();
        return build_context_state_json_locked(
            status,
            error && error[0]
                ? error
                : "Failed to apply runtime mix modulation profile.");
      }
    }

    duration_sec_ = sbx_context_duration_sec(next_ctx.get());
    context_ = std::move(next_ctx);
    mix_path_ = requested_mix_path;
    if (mix_required) {
      mix_source_name_ = mix_source_name.empty() ? requested_mix_path : mix_source_name;
      mix_looping_ = mix_looping;
      mix_cursor_frame_ = 0U;
      mix_samples_.assign(mix_samples, mix_samples + mix_sample_count);
    }

    return build_context_state_json_locked(SBX_OK, "");
  }

  std::string context_state_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    return build_context_state_json_locked(SBX_OK, "");
  }

  std::string reset_context() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!context_) {
      return build_context_state_json_locked(SBX_ENOTREADY,
                                             "No context prepared.");
    }

    sbx_context_reset(context_.get());
    mix_cursor_frame_ = 0U;
    return build_context_state_json_locked(SBX_OK, "");
  }

  std::string release_context() {
    std::lock_guard<std::mutex> lock(mutex_);
    clear_locked();
    return build_context_state_json_locked(SBX_OK, "");
  }

  std::string render_preview_json(size_t frames, size_t sample_value_count) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!context_) {
      return build_preview_json_locked(SBX_ENOTREADY,
                                       frames,
                                       0.0,
                                       0.0,
                                       nullptr,
                                       0,
                                       "No context prepared.");
    }
    if (frames == 0U) {
      return build_preview_json_locked(SBX_EINVAL,
                                       frames,
                                       0.0,
                                       0.0,
                                       nullptr,
                                       0,
                                       "frameCount must be greater than zero.");
    }

    const size_t sample_count = frames * static_cast<size_t>(config_.channels);
    preview_buffer_.assign(sample_count, 0.0f);
    const double resume_time = sbx_context_time_sec(context_.get());
    const size_t resume_mix_cursor = mix_cursor_frame_;

    const int render_status =
        sbx_context_render_f32(context_.get(), preview_buffer_.data(), frames);
    if (render_status != SBX_OK) {
      const char *error = sbx_context_last_error(context_.get());
      return build_preview_json_locked(
          render_status,
          frames,
          0.0,
          0.0,
          nullptr,
          0,
          error && error[0] ? error : "Failed to render preview frames.");
    }

    const int mix_status =
        apply_mix_stream_locked(preview_buffer_.data(), frames, resume_time);
    if (mix_status != SBX_OK) {
      mix_cursor_frame_ = resume_mix_cursor;
      return build_preview_json_locked(
          mix_status,
          frames,
          0.0,
          0.0,
          nullptr,
          0,
          context_error_locked());
    }

    float peak_abs = 0.0f;
    double sum_squares = 0.0;
    for (float value : preview_buffer_) {
      const float magnitude = std::fabs(value);
      if (magnitude > peak_abs) {
        peak_abs = magnitude;
      }
      sum_squares += static_cast<double>(value) * value;
    }

    const double rms =
        preview_buffer_.empty()
            ? 0.0
            : std::sqrt(sum_squares / static_cast<double>(preview_buffer_.size()));

    const size_t preview_value_count =
        std::min(sample_value_count, preview_buffer_.size());

    const int restore_status =
        sbx_context_set_time_sec(context_.get(), resume_time);
    mix_cursor_frame_ = resume_mix_cursor;
    if (restore_status != SBX_OK) {
      const char *error = sbx_context_last_error(context_.get());
      return build_preview_json_locked(
          restore_status,
          frames,
          peak_abs,
          rms,
          preview_buffer_.data(),
          preview_value_count,
          error && error[0] ? error : "Failed to restore context time.");
    }

    return build_preview_json_locked(SBX_OK,
                                     frames,
                                     peak_abs,
                                     rms,
                                     preview_buffer_.data(),
                                     preview_value_count,
                                     "");
  }

  int render_into_buffer(float *out, size_t frames, size_t sample_capacity) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!context_) {
      return SBX_ENOTREADY;
    }

    const size_t required_samples =
        frames * static_cast<size_t>(config_.channels);
    if (sample_capacity < required_samples) {
      return SBX_EINVAL;
    }

    const double start_time_sec = sbx_context_time_sec(context_.get());
    const int render_status = sbx_context_render_f32(context_.get(), out, frames);
    if (render_status != SBX_OK) {
      return render_status;
    }

    return apply_mix_stream_locked(out, frames, start_time_sec);
  }

 private:
  std::string build_context_state_json_locked(
      int status, const std::string &override_error) const {
    const std::string error =
        !override_error.empty() ? override_error : context_error_locked();

    std::ostringstream json;
    json << '{'
         << "\"status\":" << status << ','
         << "\"statusText\":\"" << escape_json(status_text(status)) << "\","
         << "\"prepared\":" << (context_ ? "true" : "false") << ','
         << "\"sampleRate\":" << config_.sample_rate << ','
         << "\"channels\":" << config_.channels << ','
         << "\"timeSec\":" << (context_ ? sbx_context_time_sec(context_.get()) : 0.0)
         << ','
         << "\"durationSec\":" << (context_ ? duration_sec_ : 0.0) << ','
         << "\"sourceName\":\"" << escape_json(source_name_) << "\","
         << "\"mixActive\":" << (!mix_samples_.empty() ? "true" : "false") << ','
         << "\"mixLooping\":" << (mix_looping_ ? "true" : "false") << ','
         << "\"mixPath\":\"" << escape_json(mix_path_) << "\","
         << "\"mixSourceName\":\"" << escape_json(mix_source_name_) << "\","
         << "\"error\":\"" << escape_json(error) << "\""
         << '}';

    return json.str();
  }

  std::string build_preview_json_locked(int status,
                                        size_t frames,
                                        double peak_abs,
                                        double rms,
                                        const float *samples,
                                        size_t sample_count,
                                        const std::string &override_error) const {
    const std::string error =
        !override_error.empty() ? override_error : context_error_locked();

    std::ostringstream json;
    json << '{'
         << "\"status\":" << status << ','
         << "\"statusText\":\"" << escape_json(status_text(status)) << "\","
         << "\"prepared\":" << (context_ ? "true" : "false") << ','
         << "\"sampleRate\":" << config_.sample_rate << ','
         << "\"channels\":" << config_.channels << ','
         << "\"frameCount\":" << frames << ','
         << "\"sampleValueCount\":" << sample_count << ','
         << "\"timeSec\":" << (context_ ? sbx_context_time_sec(context_.get()) : 0.0)
         << ','
         << "\"durationSec\":" << (context_ ? duration_sec_ : 0.0) << ','
         << "\"peakAbs\":" << peak_abs << ','
         << "\"rms\":" << rms << ','
         << "\"sourceName\":\"" << escape_json(source_name_) << "\","
         << "\"mixActive\":" << (!mix_samples_.empty() ? "true" : "false") << ','
         << "\"mixLooping\":" << (mix_looping_ ? "true" : "false") << ','
         << "\"mixPath\":\"" << escape_json(mix_path_) << "\","
         << "\"mixSourceName\":\"" << escape_json(mix_source_name_) << "\","
         << "\"error\":\"" << escape_json(error) << "\","
         << "\"samples\":";

    if (samples && sample_count > 0U) {
      append_float_array_json(json, samples, sample_count);
    } else {
      json << "[]";
    }

    json << '}';
    return json.str();
  }

  std::string context_error_locked() const {
    if (!context_) {
      return {};
    }

    const char *error = sbx_context_last_error(context_.get());
    return error && error[0] ? error : "";
  }

  void clear_locked() {
    context_.reset();
    source_name_.clear();
    duration_sec_ = 0.0;
    preview_buffer_.clear();
    mix_samples_.clear();
    mix_path_.clear();
    mix_source_name_.clear();
    mix_cursor_frame_ = 0U;
    mix_looping_ = false;
  }

  int apply_mix_stream_locked(float *io, size_t frames, double start_time_sec) {
    if (!context_ || !io || mix_samples_.empty()) {
      return SBX_OK;
    }

    const size_t mix_frame_count =
        mix_samples_.size() / static_cast<size_t>(config_.channels);
    if (mix_frame_count == 0U) {
      return SBX_OK;
    }

    const double sample_rate = config_.sample_rate;
    if (!(std::isfinite(sample_rate) && sample_rate > 0.0)) {
      return SBX_ENOTREADY;
    }

    size_t cursor_frame = mix_cursor_frame_;
    for (size_t frame = 0; frame < frames; ++frame) {
      if (cursor_frame >= mix_frame_count) {
        if (!mix_looping_) {
          break;
        }
        cursor_frame = 0U;
      }

      double mix_add_l = 0.0;
      double mix_add_r = 0.0;
      const size_t sample_index = frame * 2U;
      const size_t mix_index = cursor_frame * 2U;
      const int status = sbx_context_mix_stream_sample(
          context_.get(),
          start_time_sec + static_cast<double>(frame) / sample_rate,
          static_cast<int>(mix_samples_[mix_index]),
          static_cast<int>(mix_samples_[mix_index + 1U]),
          1.0,
          &mix_add_l,
          &mix_add_r);
      if (status != SBX_OK) {
        return status;
      }

      const double out_l = static_cast<double>(io[sample_index]) * 32767.0 + mix_add_l;
      const double out_r =
          static_cast<double>(io[sample_index + 1U]) * 32767.0 + mix_add_r;
      io[sample_index] = clamp_unit_float(out_l / 32767.0);
      io[sample_index + 1U] = clamp_unit_float(out_r / 32767.0);
      ++cursor_frame;
    }

    mix_cursor_frame_ = cursor_frame;
    return SBX_OK;
  }

  mutable std::mutex mutex_;
  SbxEngineConfig config_{};
  std::unique_ptr<SbxContext, ContextDeleter> context_;
  std::string source_name_;
  double duration_sec_ = 0.0;
  std::vector<float> preview_buffer_;
  std::vector<int16_t> mix_samples_;
  std::string mix_path_;
  std::string mix_source_name_;
  size_t mix_cursor_frame_ = 0U;
  bool mix_looping_ = false;
};

BridgeRuntimeState &runtime_state() {
  static BridgeRuntimeState state;
  return state;
}

std::string build_bridge_info_json() {
  std::ostringstream json;
  json << '{'
       << "\"bridgeVersion\":\"" << kBridgeVersion << "\","
       << "\"libraryVersion\":\"" << escape_json(sbx_version()) << "\","
       << "\"apiVersion\":" << sbx_api_version()
       << '}';
  return json.str();
}

bool diagnostics_have_errors(const SbxDiagnostic *diags, size_t count) {
  for (size_t index = 0; index < count; ++index) {
    if (diags[index].severity != SBX_DIAG_WARNING) {
      return true;
    }
  }

  return false;
}

bool inspect_curve_info(const std::string &text,
                        const std::string &source_name,
                        CurveInspection *out) {
  if (!out) {
    return false;
  }

  out->available = false;
  out->info = SbxCurveInfo{};
  out->parameters.clear();

  std::unique_ptr<SbxCurveProgram, CurveDeleter> curve(sbx_curve_create());
  if (!curve) {
    return false;
  }

  SbxCurveEvalConfig cfg{};
  sbx_default_curve_eval_config(&cfg);

  if (sbx_curve_load_text(curve.get(), text.c_str(), source_name.c_str()) !=
      SBX_OK) {
    return false;
  }

  if (sbx_curve_prepare(curve.get(), &cfg) != SBX_OK) {
    return false;
  }

  if (sbx_curve_get_info(curve.get(), &out->info) != SBX_OK) {
    return false;
  }

  const size_t param_count = sbx_curve_param_count(curve.get());
  out->parameters.reserve(param_count);

  for (size_t index = 0; index < param_count; ++index) {
    const char *name = nullptr;
    double value = 0.0;
    if (sbx_curve_get_param(curve.get(), index, &name, &value) != SBX_OK ||
        !name) {
      continue;
    }

    out->parameters.push_back(CurveParameterSnapshot{name, value});
  }

  out->available = true;
  return true;
}

std::string build_validation_json(int status,
                                  const SbxDiagnostic *diags,
                                  size_t count,
                                  const CurveInspection *curve_inspection =
                                      nullptr) {
  std::ostringstream json;

  json << '{'
       << "\"status\":" << status << ','
       << "\"statusText\":\"" << escape_json(status_text(status)) << "\","
       << "\"diagnosticCount\":" << count << ','
       << "\"diagnostics\":";

  append_diagnostics_json(json, diags, count);
  json << ",\"curveInfo\":";
  if (curve_inspection && curve_inspection->available) {
    append_curve_info_json(json, *curve_inspection);
  } else {
    json << "null";
  }
  json << '}';

  return json.str();
}

std::string validate_text(const std::string &text,
                          const std::string &source_name,
                          bool is_sbg) {
  SbxDiagnostic *diags = nullptr;
  size_t count = 0U;
  CurveInspection curve_inspection;
  const CurveInspection *curve_info_json = nullptr;
  const std::string safe_source =
      source_name.empty() ? (is_sbg ? "scratch.sbg" : "scratch.sbgf")
                          : source_name;

  const int status = is_sbg
                         ? sbx_validate_sbg_text(text.c_str(),
                                                 safe_source.c_str(),
                                                 &diags,
                                                 &count)
                         : sbx_validate_sbgf_text(text.c_str(),
                                                  safe_source.c_str(),
                                                  &diags,
                                                  &count);

  if (!is_sbg && status == SBX_OK && !diagnostics_have_errors(diags, count) &&
      inspect_curve_info(text, safe_source, &curve_inspection)) {
    curve_info_json = &curve_inspection;
  }

  const std::string json =
      build_validation_json(status, diags, count, curve_info_json);
  if (diags) {
    sbx_free_diagnostics(diags);
  }

  return json;
}

std::string inspect_sbg_runtime_json(const std::string &text,
                                     const std::string &source_name) {
  const std::string safe_source =
      source_name.empty() ? "scratch.sbg" : source_name;
  SafeSeqPreparedText prepared;
  std::string error;
  const int status = parse_safe_sbg_text(text, &prepared, &error);
  const double sample_rate =
      status == SBX_OK && prepared.config.have_r ? prepared.config.rate : 44100.0;
  const std::string mix_path =
      status == SBX_OK && prepared.config.mix_path ? prepared.config.mix_path : "";

  return build_sbg_runtime_config_json(status,
                                       safe_source,
                                       sample_rate,
                                       mix_path,
                                       error);
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeGetBridgeInfo(
    JNIEnv *env,
    jobject /* this */) {
  return to_jstring(env, build_bridge_info_json());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeValidateSbg(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jstring source_name) {
  return to_jstring(env,
                    validate_text(jstring_to_utf8(env, text),
                                  jstring_to_utf8(env, source_name),
                                  true));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeValidateSbgf(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jstring source_name) {
  return to_jstring(env,
                    validate_text(jstring_to_utf8(env, text),
                                  jstring_to_utf8(env, source_name),
                                  false));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeInspectSbgRuntimeConfig(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jstring source_name) {
  return to_jstring(env,
                    inspect_sbg_runtime_json(jstring_to_utf8(env, text),
                                             jstring_to_utf8(env, source_name)));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativePrepareSbgContext(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jstring source_name,
    jshortArray mix_samples,
    jstring mix_source_name,
    jboolean mix_looping) {
  std::vector<int16_t> mix_copy;
  if (mix_samples) {
    const jsize mix_count = env->GetArrayLength(mix_samples);
    if (mix_count > 0) {
      mix_copy.resize(static_cast<size_t>(mix_count));
      env->GetShortArrayRegion(mix_samples,
                               0,
                               mix_count,
                               reinterpret_cast<jshort *>(mix_copy.data()));
    }
  }

  return to_jstring(env,
                    runtime_state().prepare_sbg_context(
                        jstring_to_utf8(env, text),
                        jstring_to_utf8(env, source_name),
                        mix_copy.empty() ? nullptr : mix_copy.data(),
                        mix_copy.size(),
                        jstring_to_utf8(env, mix_source_name),
                        mix_looping == JNI_TRUE));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeGetContextState(
    JNIEnv *env,
    jobject /* this */) {
  return to_jstring(env, runtime_state().context_state_json());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeRenderPreview(
    JNIEnv *env,
    jobject /* this */,
    jint frame_count,
    jint sample_value_count) {
  return to_jstring(
      env,
      runtime_state().render_preview_json(
          frame_count > 0 ? static_cast<size_t>(frame_count) : 0U,
          sample_value_count > 0 ? static_cast<size_t>(sample_value_count)
                                 : 0U));
}

extern "C" JNIEXPORT jint JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeRenderIntoBuffer(
    JNIEnv *env,
    jobject /* this */,
    jfloatArray buffer,
    jint frame_count) {
  if (!buffer || frame_count <= 0) {
    return SBX_EINVAL;
  }

  const jsize sample_capacity = env->GetArrayLength(buffer);
  jfloat *out = env->GetFloatArrayElements(buffer, nullptr);
  if (!out) {
    return SBX_ENOMEM;
  }

  const int status = runtime_state().render_into_buffer(
      out,
      static_cast<size_t>(frame_count),
      static_cast<size_t>(sample_capacity));
  if (status != SBX_OK) {
    std::fill(out, out + sample_capacity, 0.0f);
  }

  env->ReleaseFloatArrayElements(buffer, out, 0);
  return status;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeResetContext(
    JNIEnv *env,
    jobject /* this */) {
  return to_jstring(env, runtime_state().reset_context());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeReleaseContext(
    JNIEnv *env,
    jobject /* this */) {
  return to_jstring(env, runtime_state().release_context());
}
