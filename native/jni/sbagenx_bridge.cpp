#include <jni.h>

#include <cstdio>
#include <sstream>
#include <string>

extern "C" {
#include "sbagenxlib.h"
}

namespace {

constexpr const char *kBridgeVersion = "0.1.0";

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
  const char *status_text = sbx_status_string(status);
  std::ostringstream json;

  json << '{'
       << "\"status\":" << status << ','
       << "\"statusText\":\""
       << escape_json(status_text ? status_text : "unknown")
       << "\","
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
