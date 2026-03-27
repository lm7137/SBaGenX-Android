#include <jni.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

extern "C" {
#include "sbagenxlib.h"
}

namespace {

constexpr const char *kBridgeVersion = "0.2.0";

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

struct ContextDeleter {
  void operator()(SbxContext *ctx) const {
    if (ctx) {
      sbx_context_destroy(ctx);
    }
  }
};

class BridgeRuntimeState {
 public:
  BridgeRuntimeState() {
    sbx_default_engine_config(&config_);
  }

  std::string prepare_sbg_context(const std::string &text,
                                  const std::string &source_name) {
    std::lock_guard<std::mutex> lock(mutex_);

    clear_locked();
    sbx_default_engine_config(&config_);

    SbxContext *raw_ctx = sbx_context_create(&config_);
    if (!raw_ctx) {
      return build_context_state_json_locked(SBX_ENOMEM,
                                             "Failed to create SbxContext.");
    }

    std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);
    source_name_ = source_name.empty() ? "scratch.sbg" : source_name;

    const int status =
        sbx_context_load_sbg_timing_text(next_ctx.get(), text.c_str(), 0);
    if (status != SBX_OK) {
      const char *error = sbx_context_last_error(next_ctx.get());
      clear_locked();
      return build_context_state_json_locked(
          status, error && error[0] ? error : "Failed to load .sbg text.");
    }

    duration_sec_ = sbx_context_duration_sec(next_ctx.get());
    context_ = std::move(next_ctx);
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

    return sbx_context_render_f32(context_.get(), out, frames);
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
  }

  mutable std::mutex mutex_;
  SbxEngineConfig config_{};
  std::unique_ptr<SbxContext, ContextDeleter> context_;
  std::string source_name_;
  double duration_sec_ = 0.0;
  std::vector<float> preview_buffer_;
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

std::string build_validation_json(int status,
                                  const SbxDiagnostic *diags,
                                  size_t count) {
  std::ostringstream json;

  json << '{'
       << "\"status\":" << status << ','
       << "\"statusText\":\"" << escape_json(status_text(status)) << "\","
       << "\"diagnosticCount\":" << count << ','
       << "\"diagnostics\":";

  append_diagnostics_json(json, diags, count);
  json << '}';

  return json.str();
}

std::string validate_text(const std::string &text,
                          const std::string &source_name,
                          bool is_sbg) {
  SbxDiagnostic *diags = nullptr;
  size_t count = 0U;
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

  const std::string json = build_validation_json(status, diags, count);
  if (diags) {
    sbx_free_diagnostics(diags);
  }

  return json;
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
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativePrepareSbgContext(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jstring source_name) {
  return to_jstring(env,
                    runtime_state().prepare_sbg_context(
                        jstring_to_utf8(env, text),
                        jstring_to_utf8(env, source_name)));
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
