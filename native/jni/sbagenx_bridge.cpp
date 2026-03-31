#include <jni.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
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

constexpr const char *kBridgeVersion = "0.5.0";
constexpr int kDefaultProgramDropSec = 1800;
constexpr int kDefaultProgramHoldSec = 1800;
constexpr int kDefaultProgramWakeSec = 180;
constexpr int kDefaultProgramStepLenSec = 180;
constexpr int kShortProgramStepLenSec = 60;

struct CurveParameterSnapshot {
  std::string name;
  double value = 0.0;
};

struct CurveInspection {
  bool available = false;
  SbxCurveInfo info{};
  std::vector<CurveParameterSnapshot> parameters;
};

struct MixLooperPlanSpec {
  int source_start_frame = 0;
  int source_frame_count = 0;
  int segment_min_frames = 0;
  int segment_max_frames = 0;
  int fade_frames = 0;
  int intro_frames = 0;
  bool dual_channel = false;
  bool swap_stereo = true;
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

std::string build_mix_looper_plan_json(int status,
                                       const MixLooperPlanSpec *plan,
                                       const std::string &error) {
  std::ostringstream json;
  json << '{'
       << "\"status\":" << status << ','
       << "\"statusText\":\"" << escape_json(status_text(status)) << "\","
       << "\"error\":\"" << escape_json(error) << '"';

  if (plan) {
    json << ','
         << "\"sourceStartFrame\":" << plan->source_start_frame << ','
         << "\"sourceFrameCount\":" << plan->source_frame_count << ','
         << "\"segmentMinFrames\":" << plan->segment_min_frames << ','
         << "\"segmentMaxFrames\":" << plan->segment_max_frames << ','
         << "\"fadeFrames\":" << plan->fade_frames << ','
         << "\"introFrames\":" << plan->intro_frames << ','
         << "\"dualChannel\":" << (plan->dual_channel ? "true" : "false")
         << ','
         << "\"swapStereo\":" << (plan->swap_stereo ? "true" : "false");
  }

  json << '}';
  return json.str();
}

bool parse_mix_looper_plan(const std::string &spec,
                           int sample_rate,
                           int total_frames,
                           int mix_section,
                           MixLooperPlanSpec *out,
                           std::string *error_out) {
  if (!out) {
    if (error_out) {
      *error_out = "Missing looper plan output.";
    }
    return false;
  }
  if (sample_rate <= 0) {
    if (error_out) {
      *error_out = "Sample rate must be positive for SBAGEN_LOOPER parsing.";
    }
    return false;
  }
  if (total_frames <= 0) {
    if (error_out) {
      *error_out = "Mix input did not produce any PCM frames for SBAGEN_LOOPER parsing.";
    }
    return false;
  }

  const char *looper = spec.c_str();
  bool intro = false;
  int prev_flag = 0;
  bool on = true;
  const int active_section = mix_section < 0 ? 0 : mix_section;

  int data_count = total_frames;
  int data_base = 0;
  int seg0 = data_count;
  int seg1 = data_count;
  int fade_count = sample_rate;
  bool dual_channel = false;
  bool swap_stereo = true;

  if (*looper == 'i') {
    if (std::isspace(static_cast<unsigned char>(looper[1])) != 0) {
      intro = true;
    }
    ++looper;
  }

  while (*looper != '\0') {
    char flag = *looper++;
    if (std::isspace(static_cast<unsigned char>(flag)) != 0) {
      continue;
    }
    if (!std::strchr("s-fcwd#", flag)) {
      continue;
    }
    if (flag == '-') {
      switch (prev_flag) {
        case 's':
          flag = 'S';
          break;
        case 'd':
          flag = 'D';
          break;
        default:
          continue;
      }
    }
    prev_flag = flag;

    char *number_end = nullptr;
    const double value = std::strtod(looper, &number_end);
    if (number_end == looper || !std::isfinite(value)) {
      continue;
    }
    looper = number_end;

    if (flag == '#') {
      on = (static_cast<int>(value) == active_section);
      continue;
    }
    if (!on) {
      continue;
    }

    switch (flag) {
      case 's':
        seg0 = seg1 = static_cast<int>(value * sample_rate);
        break;
      case 'S':
        seg1 = static_cast<int>(value * sample_rate);
        break;
      case 'd':
        data_base = static_cast<int>(value * sample_rate);
        data_count = total_frames - data_base;
        break;
      case 'D':
        data_count = static_cast<int>(value * sample_rate) - data_base;
        break;
      case 'f':
        fade_count = static_cast<int>(value * sample_rate);
        break;
      case 'c':
        dual_channel = value > 1.5;
        break;
      case 'w':
        swap_stereo = value > 0.5;
        break;
      default:
        break;
    }
  }

  if (fade_count < sample_rate / 50) {
    fade_count = sample_rate / 50;
  }
  if (data_count + data_base > total_frames) {
    data_count = total_frames - data_base;
  }
  if (data_count < 0) {
    if (error_out) {
      *error_out = "Source data range invalid in SBAGEN_LOOPER settings.";
    }
    return false;
  }
  if (data_count <= 3 * fade_count) {
    if (error_out) {
      *error_out =
          "Length of source data is too short for the SBAGEN_LOOPER fade length.";
    }
    return false;
  }
  if (seg0 > data_count) {
    seg0 = data_count;
  }
  if (seg1 > data_count) {
    seg1 = data_count;
  }
  if (seg0 > seg1) {
    seg0 = seg1;
  }
  if (seg0 < 3 * fade_count) {
    seg0 = 3 * fade_count;
  }
  if (seg1 < seg0) {
    seg1 = seg0;
  }

  out->source_start_frame = data_base;
  out->source_frame_count = data_count;
  out->segment_min_frames = seg0;
  out->segment_max_frames = seg1;
  out->fade_frames = fade_count;
  out->intro_frames = (intro && data_base > 0) ? data_base : 0;
  out->dual_channel = dual_channel;
  out->swap_stereo = swap_stereo;
  return true;
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

struct ProgramKeyframesDeleter {
  void operator()(SbxProgramKeyframe *frames) const {
    if (frames) {
      std::free(frames);
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

enum class ProgramKind {
  kDrop,
  kSigmoid,
  kSlide,
  kCurve,
};

struct CurveParameterOverride {
  std::string name;
  double value = 0.0;
};

struct ProgramRequest {
  ProgramKind kind = ProgramKind::kDrop;
  std::string main_arg;
  int drop_time_sec = kDefaultProgramDropSec;
  int hold_time_sec = kDefaultProgramHoldSec;
  int wake_time_sec = kDefaultProgramWakeSec;
  std::string curve_text;
  std::string source_name;
  std::string mix_path;
};

struct DropLikeMainArg {
  bool mute_program_tone = false;
  bool slide = false;
  bool include_hold = false;
  bool wake_enabled = false;
  bool is_isochronic = false;
  bool is_monaural = false;
  int step_len_sec = kDefaultProgramStepLenSec;
  double carrier_base_hz = 200.0;
  double beat_target_hz = 2.5;
  double beat_start_hz = 10.0;
  double amp_pct = 100.0;
  double sig_l = 0.125;
  double sig_h = 0.0;
  std::vector<CurveParameterOverride> curve_overrides;
};

struct SlideMainArg {
  bool is_isochronic = false;
  bool is_monaural = false;
  double carrier_start_hz = 200.0;
  double carrier_end_hz = 5.0;
  double beat_hz = 10.0;
  double amp_pct = 100.0;
};

std::string trim_ascii(const std::string &input) {
  size_t start = 0U;
  while (start < input.size() &&
         std::isspace(static_cast<unsigned char>(input[start])) != 0) {
    ++start;
  }

  size_t end = input.size();
  while (end > start &&
         std::isspace(static_cast<unsigned char>(input[end - 1U])) != 0) {
    --end;
  }

  return input.substr(start, end - start);
}

std::string lowercase_ascii(std::string input) {
  std::transform(input.begin(),
                 input.end(),
                 input.begin(),
                 [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  return input;
}

const char *program_kind_name(ProgramKind kind) {
  switch (kind) {
    case ProgramKind::kDrop:
      return "drop";
    case ProgramKind::kSigmoid:
      return "sigmoid";
    case ProgramKind::kSlide:
      return "slide";
    case ProgramKind::kCurve:
      return "curve";
  }

  return "drop";
}

bool parse_program_kind(const std::string &input, ProgramKind *out) {
  if (!out) {
    return false;
  }

  const std::string value = lowercase_ascii(trim_ascii(input));
  if (value == "drop") {
    *out = ProgramKind::kDrop;
    return true;
  }
  if (value == "sigmoid") {
    *out = ProgramKind::kSigmoid;
    return true;
  }
  if (value == "slide") {
    *out = ProgramKind::kSlide;
    return true;
  }
  if (value == "curve") {
    *out = ProgramKind::kCurve;
    return true;
  }
  return false;
}

bool curve_name_char(int ch, bool first) {
  return std::isalpha(ch) != 0 || ch == '_' ||
         (!first && (std::isdigit(ch) != 0 || ch == '.'));
}

bool parse_program_target_spec(const char *text,
                               const char **end_out,
                               double *target_hz_out) {
  static constexpr double kProgramTargetVals[] = {
      4.4, 3.7, 3.1, 2.5, 2.0, 1.5, 1.2, 0.9, 0.7, 0.5, 0.4, 0.3,
  };

  if (!text || !*text) {
    return false;
  }

  bool negative = false;
  const char *cursor = text;
  if (*cursor == '+' || *cursor == '-') {
    negative = (*cursor == '-');
    ++cursor;
  }

  if (std::isalpha(static_cast<unsigned char>(*cursor)) == 0) {
    return false;
  }

  const int index = std::tolower(static_cast<unsigned char>(*cursor)) - 'a';
  if (index < 0 ||
      index >= static_cast<int>(sizeof(kProgramTargetVals) / sizeof(kProgramTargetVals[0]))) {
    return false;
  }
  ++cursor;

  double frac = 0.0;
  if (*cursor == '.') {
    char *number_end = nullptr;
    frac = std::strtod(cursor, &number_end);
    if (number_end == cursor || frac < 0.0 || frac >= 1.0) {
      return false;
    }
    cursor = number_end;
  }

  const double current = kProgramTargetVals[index];
  const double next =
      (index + 1 <
       static_cast<int>(sizeof(kProgramTargetVals) / sizeof(kProgramTargetVals[0])))
          ? kProgramTargetVals[index + 1]
          : 0.2;
  double target = current + frac * (next - current);
  if (negative) {
    target = 2.0 * kProgramTargetVals[0] - target;
  }

  if (target_hz_out) {
    *target_hz_out = target;
  }
  if (end_out) {
    *end_out = cursor;
  }
  return true;
}

void fill_program_tone_spec(SbxToneSpec *tone,
                            bool is_isochronic,
                            bool is_monaural,
                            double carrier_hz,
                            double beat_hz,
                            double amp_pct) {
  if (!tone) {
    return;
  }

  sbx_default_tone_spec(tone);
  tone->mode = is_isochronic ? SBX_TONE_ISOCHRONIC
                             : (is_monaural ? SBX_TONE_MONAURAL : SBX_TONE_BINAURAL);
  tone->carrier_hz = carrier_hz;
  tone->beat_hz = beat_hz;
  tone->amplitude = amp_pct / 100.0;
}

std::string program_default_source_name(ProgramKind kind) {
  return std::string("program:") + program_kind_name(kind);
}

bool parse_drop_like_main_arg(const std::string &main_arg,
                              ProgramKind kind,
                              DropLikeMainArg *out,
                              std::string *error_out) {
  if (!out) {
    if (error_out) {
      *error_out = "Internal program parser error.";
    }
    return false;
  }

  const std::string trimmed = trim_ascii(main_arg);
  if (trimmed.empty()) {
    if (error_out) {
      *error_out = std::string("Built-in ") + program_kind_name(kind) +
                   " requires a main argument.";
    }
    return false;
  }

  DropLikeMainArg parsed;
  const char *cursor = trimmed.c_str();
  if (*cursor == 'N' || *cursor == 'n') {
    parsed.mute_program_tone = true;
    parsed.carrier_base_hz = 200.0;
    ++cursor;
  } else {
    char *number_end = nullptr;
    const double level = std::strtod(cursor, &number_end);
    if (number_end == cursor) {
      if (error_out) {
        *error_out = std::string("Invalid ") + program_kind_name(kind) +
                     " level prefix.";
      }
      return false;
    }
    parsed.carrier_base_hz = 200.0 - 2.0 * level;
    if (!(std::isfinite(parsed.carrier_base_hz) &&
          parsed.carrier_base_hz >= 0.0)) {
      if (error_out) {
        *error_out =
            std::string("Invalid ") + program_kind_name(kind) +
            " carrier start derived from the level prefix.";
      }
      return false;
    }
    cursor = number_end;
  }

  const char *target_end = nullptr;
  if (!parse_program_target_spec(cursor, &target_end, &parsed.beat_target_hz)) {
    if (error_out) {
      *error_out =
          std::string("Invalid ") + program_kind_name(kind) + " target spec.";
    }
    return false;
  }
  cursor = target_end;

  bool have_step_mode = false;
  while (*cursor != '\0') {
    if (std::isspace(static_cast<unsigned char>(*cursor)) != 0) {
      ++cursor;
      continue;
    }

    if (*cursor == 's' || *cursor == 'k') {
      if (have_step_mode) {
        if (error_out) {
          *error_out =
              std::string("Duplicate step/slide flag in ") +
              program_kind_name(kind) + " main argument.";
        }
        return false;
      }
      have_step_mode = true;
      if (*cursor == 's') {
        parsed.slide = true;
        parsed.step_len_sec = kShortProgramStepLenSec;
      } else {
        parsed.step_len_sec = kShortProgramStepLenSec;
      }
      ++cursor;
      continue;
    }
    if (*cursor == '+') {
      parsed.include_hold = true;
      ++cursor;
      continue;
    }
    if (*cursor == '^') {
      parsed.wake_enabled = true;
      ++cursor;
      continue;
    }
    if (*cursor == '@') {
      parsed.is_isochronic = true;
      ++cursor;
      continue;
    }
    if (*cursor == 'M') {
      parsed.is_monaural = true;
      ++cursor;
      continue;
    }
    if (*cursor == '/') {
      ++cursor;
      char *number_end = nullptr;
      const double amp_pct = std::strtod(cursor, &number_end);
      if (number_end == cursor || !std::isfinite(amp_pct) || amp_pct < 0.0) {
        if (error_out) {
          *error_out =
              std::string("Invalid amplitude suffix in ") +
              program_kind_name(kind) + " main argument.";
        }
        return false;
      }
      parsed.amp_pct = amp_pct;
      cursor = number_end;
      continue;
    }
    if (*cursor == ':') {
      ++cursor;
      if (cursor[0] == 'S' && cursor[1] == '=') {
        cursor += 2;
        char *number_end = nullptr;
        const double beat_start = std::strtod(cursor, &number_end);
        if (number_end == cursor || !std::isfinite(beat_start) ||
            beat_start <= 0.0) {
          if (error_out) {
            *error_out =
                std::string("Invalid :S= value in ") +
                program_kind_name(kind) + " main argument.";
          }
          return false;
        }
        parsed.beat_start_hz = beat_start;
        cursor = number_end;
        continue;
      }

      if (kind == ProgramKind::kSigmoid &&
          ((cursor[0] == 'l' || cursor[0] == 'h') && cursor[1] == '=')) {
        const char which = cursor[0];
        cursor += 2;
        char *number_end = nullptr;
        const double value = std::strtod(cursor, &number_end);
        if (number_end == cursor || !std::isfinite(value)) {
          if (error_out) {
            *error_out =
                std::string("Invalid :") + which + "= value in sigmoid main argument.";
          }
          return false;
        }
        if (which == 'l') {
          parsed.sig_l = value;
        } else {
          parsed.sig_h = value;
        }
        cursor = number_end;
        continue;
      }

      if (kind == ProgramKind::kCurve) {
        if (!curve_name_char(static_cast<unsigned char>(*cursor), true)) {
          if (error_out) {
            *error_out = "Invalid curve parameter override name.";
          }
          return false;
        }

        std::string name;
        name.push_back(*cursor++);
        while (*cursor != '\0' &&
               curve_name_char(static_cast<unsigned char>(*cursor), false)) {
          name.push_back(*cursor++);
        }
        if (*cursor != '=') {
          if (error_out) {
            *error_out = "Invalid curve parameter override syntax.";
          }
          return false;
        }
        ++cursor;

        char *number_end = nullptr;
        const double value = std::strtod(cursor, &number_end);
        if (number_end == cursor || !std::isfinite(value)) {
          if (error_out) {
            *error_out = "Invalid curve parameter override value.";
          }
          return false;
        }
        parsed.curve_overrides.push_back(CurveParameterOverride{name, value});
        cursor = number_end;
        continue;
      }

      if (error_out) {
        *error_out =
            std::string("Unsupported : option in ") + program_kind_name(kind) +
            " main argument.";
      }
      return false;
    }

    if (error_out) {
      *error_out =
          std::string("Trailing text in ") + program_kind_name(kind) +
          " main argument.";
    }
    return false;
  }

  if (parsed.is_monaural && parsed.is_isochronic) {
    if (error_out) {
      *error_out =
          std::string("Monaural mode cannot be combined with isochronic mode for ") +
          program_kind_name(kind) + '.';
    }
    return false;
  }

  if (parsed.mute_program_tone) {
    parsed.amp_pct = 0.0;
  }

  *out = parsed;
  return true;
}

bool parse_slide_main_arg(const std::string &main_arg,
                          SlideMainArg *out,
                          std::string *error_out) {
  if (!out) {
    if (error_out) {
      *error_out = "Internal slide parser error.";
    }
    return false;
  }

  const std::string trimmed = trim_ascii(main_arg);
  if (trimmed.empty()) {
    if (error_out) {
      *error_out = "Built-in slide requires a main argument.";
    }
    return false;
  }

  const char *cursor = trimmed.c_str();
  char *number_end = nullptr;
  const double carrier_hz = std::strtod(cursor, &number_end);
  if (number_end == cursor || !std::isfinite(carrier_hz) || carrier_hz <= 0.0) {
    if (error_out) {
      *error_out = "Invalid slide carrier frequency.";
    }
    return false;
  }
  cursor = number_end;

  const char signal = *cursor;
  if (signal != '+' && signal != '-' && signal != '@' && signal != 'M') {
    if (error_out) {
      *error_out = "Slide expects +, -, @, or M between carrier and beat.";
    }
    return false;
  }
  ++cursor;

  number_end = nullptr;
  const double beat_hz = std::strtod(cursor, &number_end);
  if (number_end == cursor || !std::isfinite(beat_hz)) {
    if (error_out) {
      *error_out = "Invalid slide beat value.";
    }
    return false;
  }
  cursor = number_end;

  if (*cursor != '/') {
    if (error_out) {
      *error_out = "Slide expects /<amp> after the beat value.";
    }
    return false;
  }
  ++cursor;

  number_end = nullptr;
  const double amp_pct = std::strtod(cursor, &number_end);
  if (number_end == cursor || !std::isfinite(amp_pct) || amp_pct < 0.0) {
    if (error_out) {
      *error_out = "Invalid slide amplitude value.";
    }
    return false;
  }
  cursor = number_end;

  while (*cursor != '\0' &&
         std::isspace(static_cast<unsigned char>(*cursor)) != 0) {
    ++cursor;
  }
  if (*cursor != '\0') {
    if (error_out) {
      *error_out = "Trailing text in slide main argument.";
    }
    return false;
  }

  SlideMainArg parsed;
  parsed.is_isochronic = signal == '@';
  parsed.is_monaural = signal == 'M';
  parsed.carrier_start_hz = carrier_hz;
  parsed.carrier_end_hz = beat_hz / 2.0;
  parsed.beat_hz = signal == '-' ? -std::fabs(beat_hz) : std::fabs(beat_hz);
  parsed.amp_pct = amp_pct;

  *out = parsed;
  return true;
}

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
    return prepare_sbg_context_impl(text,
                                    source_name,
                                    mix_samples,
                                    mix_sample_count,
                                    mix_source_name,
                                    mix_looping,
                                    false);
  }

  std::string prepare_sbg_context_streaming(const std::string &text,
                                            const std::string &source_name,
                                            const std::string &mix_source_name,
                                            bool mix_looping) {
    return prepare_sbg_context_impl(text,
                                    source_name,
                                    nullptr,
                                    0U,
                                    mix_source_name,
                                    mix_looping,
                                    true);
  }

  std::string prepare_program_context(const ProgramRequest &request,
                                      const int16_t *mix_samples,
                                      size_t mix_sample_count,
                                      const std::string &mix_source_name,
                                      bool mix_looping) {
    return prepare_program_context_impl(request,
                                        mix_samples,
                                        mix_sample_count,
                                        mix_source_name,
                                        mix_looping,
                                        false);
  }

  std::string prepare_program_context_streaming(
      const ProgramRequest &request,
      const std::string &mix_source_name,
      bool mix_looping) {
    return prepare_program_context_impl(request,
                                        nullptr,
                                        0U,
                                        mix_source_name,
                                        mix_looping,
                                        true);
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
        apply_stored_mix_stream_locked(preview_buffer_.data(), frames, resume_time);
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

    return apply_stored_mix_stream_locked(out, frames, start_time_sec);
  }

  int render_into_buffer_with_mix(float *out,
                                  size_t frames,
                                  size_t sample_capacity,
                                  const int16_t *mix_samples,
                                  size_t mix_frame_count) {
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

    if (!mix_active_ || !mix_samples || mix_frame_count == 0U) {
      return SBX_OK;
    }

    return apply_supplied_mix_stream_locked(
        out, frames, start_time_sec, mix_samples, mix_frame_count);
  }

 private:
  std::string adopt_context_locked(
      std::unique_ptr<SbxContext, ContextDeleter> next_ctx,
      double duration_sec,
      const std::string &mix_path,
      const std::string &mix_source_name,
      bool mix_looping,
      const int16_t *mix_samples,
      size_t mix_sample_count) {
    duration_sec_ = duration_sec;
    context_ = std::move(next_ctx);
    mix_path_ = mix_path;
    mix_source_name_.clear();
    mix_looping_ = false;
    mix_active_ = false;
    mix_cursor_frame_ = 0U;
    mix_samples_.clear();

    if (!mix_path.empty()) {
      mix_active_ = true;
      mix_looping_ = mix_looping;
      mix_source_name_ = mix_source_name.empty() ? mix_path : mix_source_name;
      if (mix_samples && mix_sample_count > 0U) {
        mix_samples_.assign(mix_samples, mix_samples + mix_sample_count);
      }
    }

    return build_context_state_json_locked(SBX_OK, "");
  }

  std::string prepare_program_context_impl(const ProgramRequest &request,
                                           const int16_t *mix_samples,
                                           size_t mix_sample_count,
                                           const std::string &mix_source_name,
                                           bool mix_looping,
                                           bool allow_streaming_without_samples) {
    std::lock_guard<std::mutex> lock(mutex_);

    clear_locked();
    source_name_ = request.source_name.empty()
                       ? program_default_source_name(request.kind)
                       : request.source_name;
    mix_path_ = request.mix_path;

    sbx_default_engine_config(&config_);

    const bool mix_required = !request.mix_path.empty();
    if (mix_required && !allow_streaming_without_samples &&
        (!mix_samples || mix_sample_count < 2U)) {
      return build_context_state_json_locked(
          SBX_EINVAL,
          "This program declares a mix input, but no decoded mix stream was supplied.");
    }

    if (request.drop_time_sec <= 0 || request.hold_time_sec < 0 ||
        request.wake_time_sec < 0) {
      return build_context_state_json_locked(
          SBX_EINVAL,
          "Program timing values must be positive for the main span and non-negative for hold/wake.");
    }

    const int drop_sec = request.drop_time_sec;
    const int hold_sec_input = request.hold_time_sec;
    const int wake_sec_input = request.wake_time_sec;

    if (request.kind == ProgramKind::kSlide) {
      SlideMainArg parsed;
      std::string parse_error;
      if (!parse_slide_main_arg(request.main_arg, &parsed, &parse_error)) {
        return build_context_state_json_locked(SBX_EINVAL, parse_error);
      }

      SbxBuiltinSlideConfig prog_cfg{};
      sbx_default_builtin_slide_config(&prog_cfg);
      fill_program_tone_spec(&prog_cfg.start_tone,
                             parsed.is_isochronic,
                             parsed.is_monaural,
                             parsed.carrier_start_hz,
                             parsed.beat_hz,
                             parsed.amp_pct);
      prog_cfg.carrier_end_hz = parsed.carrier_end_hz;
      prog_cfg.slide_sec = drop_sec;

      std::unique_ptr<SbxProgramKeyframe, ProgramKeyframesDeleter> frames;
      size_t frame_count = 0U;
      SbxProgramKeyframe *raw_frames = nullptr;
      const int build_status =
          sbx_build_slide_keyframes(&prog_cfg, &raw_frames, &frame_count);
      frames.reset(raw_frames);
      if (build_status != SBX_OK) {
        return build_context_state_json_locked(
            build_status, "Failed to build the built-in slide program.");
      }

      SbxRuntimeContextConfig runtime_cfg{};
      sbx_default_runtime_context_config(&runtime_cfg);
      runtime_cfg.engine = config_;
      runtime_cfg.default_mix_amp_pct = 100.0;

      double duration_sec = 0.0;
      SbxContext *raw_ctx = nullptr;
      const int create_status = sbx_runtime_context_create_from_keyframes(
          frames.get(), frame_count, 0, &runtime_cfg, &duration_sec, &raw_ctx);
      std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);
      if (create_status != SBX_OK) {
        const char *error = raw_ctx ? sbx_context_last_error(raw_ctx) : nullptr;
        return build_context_state_json_locked(
            create_status,
            error && error[0] ? error
                              : "Failed to create the built-in slide runtime.");
      }

      return adopt_context_locked(std::move(next_ctx),
                                  duration_sec,
                                  request.mix_path,
                                  mix_source_name,
                                  mix_looping,
                                  mix_samples,
                                  mix_sample_count);
    }

    DropLikeMainArg parsed;
    std::string parse_error;
    if (!parse_drop_like_main_arg(request.main_arg,
                                  request.kind,
                                  &parsed,
                                  &parse_error)) {
      return build_context_state_json_locked(SBX_EINVAL, parse_error);
    }

    const int hold_sec = parsed.include_hold ? hold_sec_input : 0;
    const int wake_sec = parsed.wake_enabled ? wake_sec_input : 0;
    const int main_sec = drop_sec + hold_sec;
    const double carrier_start_hz = parsed.carrier_base_hz + 5.0;
    const double carrier_end_hz =
        parsed.include_hold
            ? (parsed.carrier_base_hz -
               (5.0 * static_cast<double>(hold_sec) / static_cast<double>(drop_sec)))
            : parsed.carrier_base_hz;

    if (request.kind == ProgramKind::kDrop ||
        request.kind == ProgramKind::kSigmoid) {
      if (parsed.slide) {
        std::unique_ptr<SbxCurveProgram, CurveDeleter> curve;

        if (request.kind == ProgramKind::kDrop) {
          SbxBuiltinDropConfig prog_cfg{};
          sbx_default_builtin_drop_config(&prog_cfg);
          fill_program_tone_spec(&prog_cfg.start_tone,
                                 parsed.is_isochronic,
                                 parsed.is_monaural,
                                 carrier_start_hz,
                                 parsed.beat_start_hz,
                                 parsed.amp_pct);
          prog_cfg.carrier_end_hz = carrier_end_hz;
          prog_cfg.beat_target_hz = parsed.beat_target_hz;
          prog_cfg.drop_sec = drop_sec;
          prog_cfg.hold_sec = hold_sec;
          prog_cfg.wake_sec = wake_sec;
          prog_cfg.slide = 1;
          prog_cfg.step_len_sec = parsed.step_len_sec;

          SbxCurveProgram *raw_curve = nullptr;
          const int build_status =
              sbx_build_drop_curve_program(&prog_cfg, &raw_curve);
          curve.reset(raw_curve);
          if (build_status != SBX_OK || !curve) {
            return build_context_state_json_locked(
                build_status != SBX_OK ? build_status : SBX_ENOMEM,
                "Failed to build the built-in drop runtime.");
          }
        } else {
          SbxBuiltinSigmoidConfig prog_cfg{};
          sbx_default_builtin_sigmoid_config(&prog_cfg);
          fill_program_tone_spec(&prog_cfg.start_tone,
                                 parsed.is_isochronic,
                                 parsed.is_monaural,
                                 carrier_start_hz,
                                 parsed.beat_start_hz,
                                 parsed.amp_pct);
          prog_cfg.carrier_end_hz = carrier_end_hz;
          prog_cfg.beat_target_hz = parsed.beat_target_hz;
          prog_cfg.drop_sec = drop_sec;
          prog_cfg.hold_sec = hold_sec;
          prog_cfg.wake_sec = wake_sec;
          prog_cfg.slide = 1;
          prog_cfg.step_len_sec = parsed.step_len_sec;
          prog_cfg.sig_l = parsed.sig_l;
          prog_cfg.sig_h = parsed.sig_h;

          SbxCurveProgram *raw_curve = nullptr;
          const int build_status =
              sbx_build_sigmoid_curve_program(&prog_cfg, &raw_curve);
          curve.reset(raw_curve);
          if (build_status != SBX_OK || !curve) {
            return build_context_state_json_locked(
                build_status != SBX_OK ? build_status : SBX_ENOMEM,
                "Failed to build the built-in sigmoid runtime.");
          }
        }

        SbxContext *raw_ctx = sbx_context_create(&config_);
        if (!raw_ctx) {
          return build_context_state_json_locked(SBX_ENOMEM,
                                                 "Failed to create SbxContext.");
        }
        std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);

        SbxCurveSourceConfig source_cfg{};
        sbx_default_curve_source_config(&source_cfg);
        source_cfg.mode = parsed.is_isochronic
                              ? SBX_TONE_ISOCHRONIC
                              : (parsed.is_monaural ? SBX_TONE_MONAURAL
                                                    : SBX_TONE_BINAURAL);
        source_cfg.waveform = SBX_WAVE_SINE;
        source_cfg.amplitude = 1.0;
        source_cfg.duration_sec =
            static_cast<double>(main_sec + wake_sec) + 10.0;

        int status = sbx_context_load_curve_program(next_ctx.get(),
                                                    curve.get(),
                                                    &source_cfg);
        if (status != SBX_OK) {
          const char *error = sbx_context_last_error(next_ctx.get());
          return build_context_state_json_locked(
              status,
              error && error[0] ? error
                                : "Failed to load the built-in curve runtime.");
        }
        curve.release();

        status = sbx_context_configure_runtime(
            next_ctx.get(), nullptr, 0U, 100.0, nullptr, 0U, nullptr, 0U);
        if (status != SBX_OK) {
          const char *error = sbx_context_last_error(next_ctx.get());
          return build_context_state_json_locked(
              status,
              error && error[0]
                  ? error
                  : "Failed to configure the built-in curve runtime.");
        }

        return adopt_context_locked(std::move(next_ctx),
                                    source_cfg.duration_sec,
                                    request.mix_path,
                                    mix_source_name,
                                    mix_looping,
                                    mix_samples,
                                    mix_sample_count);
      }

      std::unique_ptr<SbxProgramKeyframe, ProgramKeyframesDeleter> frames;
      size_t frame_count = 0U;
      int build_status = SBX_OK;

      if (request.kind == ProgramKind::kDrop) {
        SbxBuiltinDropConfig prog_cfg{};
        sbx_default_builtin_drop_config(&prog_cfg);
        fill_program_tone_spec(&prog_cfg.start_tone,
                               parsed.is_isochronic,
                               parsed.is_monaural,
                               carrier_start_hz,
                               parsed.beat_start_hz,
                               parsed.amp_pct);
        prog_cfg.carrier_end_hz = carrier_end_hz;
        prog_cfg.beat_target_hz = parsed.beat_target_hz;
        prog_cfg.drop_sec = drop_sec;
        prog_cfg.hold_sec = hold_sec;
        prog_cfg.wake_sec = wake_sec;
        prog_cfg.slide = 0;
        prog_cfg.step_len_sec = parsed.step_len_sec;

        SbxProgramKeyframe *raw_frames = nullptr;
        build_status = sbx_build_drop_keyframes(&prog_cfg, &raw_frames, &frame_count);
        frames.reset(raw_frames);
      } else {
        SbxBuiltinSigmoidConfig prog_cfg{};
        sbx_default_builtin_sigmoid_config(&prog_cfg);
        fill_program_tone_spec(&prog_cfg.start_tone,
                               parsed.is_isochronic,
                               parsed.is_monaural,
                               carrier_start_hz,
                               parsed.beat_start_hz,
                               parsed.amp_pct);
        prog_cfg.carrier_end_hz = carrier_end_hz;
        prog_cfg.beat_target_hz = parsed.beat_target_hz;
        prog_cfg.drop_sec = drop_sec;
        prog_cfg.hold_sec = hold_sec;
        prog_cfg.wake_sec = wake_sec;
        prog_cfg.slide = 0;
        prog_cfg.step_len_sec = parsed.step_len_sec;
        prog_cfg.sig_l = parsed.sig_l;
        prog_cfg.sig_h = parsed.sig_h;

        SbxProgramKeyframe *raw_frames = nullptr;
        build_status =
            sbx_build_sigmoid_keyframes(&prog_cfg, &raw_frames, &frame_count);
        frames.reset(raw_frames);
      }

      if (build_status != SBX_OK || !frames) {
        return build_context_state_json_locked(
            build_status != SBX_OK ? build_status : SBX_ENOMEM,
            request.kind == ProgramKind::kDrop
                ? "Failed to build the built-in drop keyframes."
                : "Failed to build the built-in sigmoid keyframes.");
      }

      SbxRuntimeContextConfig runtime_cfg{};
      sbx_default_runtime_context_config(&runtime_cfg);
      runtime_cfg.engine = config_;
      runtime_cfg.default_mix_amp_pct = 100.0;

      double duration_sec = 0.0;
      SbxContext *raw_ctx = nullptr;
      const int create_status = sbx_runtime_context_create_from_keyframes(
          frames.get(), frame_count, 0, &runtime_cfg, &duration_sec, &raw_ctx);
      std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);
      if (create_status != SBX_OK) {
        const char *error = raw_ctx ? sbx_context_last_error(raw_ctx) : nullptr;
        return build_context_state_json_locked(
            create_status,
            error && error[0]
                ? error
                : (request.kind == ProgramKind::kDrop
                       ? "Failed to create the built-in drop runtime."
                       : "Failed to create the built-in sigmoid runtime."));
      }

      return adopt_context_locked(std::move(next_ctx),
                                  duration_sec,
                                  request.mix_path,
                                  mix_source_name,
                                  mix_looping,
                                  mix_samples,
                                  mix_sample_count);
    }

    if (trim_ascii(request.curve_text).empty()) {
      return build_context_state_json_locked(
          SBX_EINVAL,
          "The curve program requires .sbgf source text.");
    }

    std::unique_ptr<SbxCurveProgram, CurveDeleter> curve(sbx_curve_create());
    if (!curve) {
      return build_context_state_json_locked(SBX_ENOMEM,
                                             "Failed to create SbxCurveProgram.");
    }

    int status = sbx_curve_load_text(curve.get(),
                                     request.curve_text.c_str(),
                                     source_name_.c_str());
    if (status != SBX_OK) {
      const char *error = sbx_curve_last_error(curve.get());
      return build_context_state_json_locked(
          status,
          error && error[0] ? error : "Failed to load .sbgf curve text.");
    }

    for (const CurveParameterOverride &override_value : parsed.curve_overrides) {
      status = sbx_curve_set_param(curve.get(),
                                   override_value.name.c_str(),
                                   override_value.value);
      if (status != SBX_OK) {
        const char *error = sbx_curve_last_error(curve.get());
        return build_context_state_json_locked(
            status,
            error && error[0]
                ? error
                : "Failed to apply a curve parameter override.");
      }
    }

    SbxCurveEvalConfig eval_cfg{};
    sbx_default_curve_eval_config(&eval_cfg);
    eval_cfg.carrier_start_hz = carrier_start_hz;
    eval_cfg.carrier_end_hz = carrier_end_hz;
    eval_cfg.carrier_span_sec = static_cast<double>(main_sec);
    eval_cfg.beat_start_hz = parsed.beat_start_hz;
    eval_cfg.beat_target_hz = parsed.beat_target_hz;
    eval_cfg.beat_span_sec = static_cast<double>(drop_sec);
    eval_cfg.hold_min = static_cast<double>(hold_sec) / 60.0;
    eval_cfg.total_min = static_cast<double>(main_sec) / 60.0;
    eval_cfg.wake_min = static_cast<double>(wake_sec) / 60.0;
    eval_cfg.beat_amp0_pct = parsed.amp_pct;
    eval_cfg.mix_amp0_pct = 100.0;

    status = sbx_curve_prepare(curve.get(), &eval_cfg);
    if (status != SBX_OK) {
      const char *error = sbx_curve_last_error(curve.get());
      return build_context_state_json_locked(
          status,
          error && error[0] ? error : "Failed to prepare the .sbgf curve.");
    }

    if (parsed.slide) {
      SbxContext *raw_ctx = sbx_context_create(&config_);
      if (!raw_ctx) {
        return build_context_state_json_locked(SBX_ENOMEM,
                                               "Failed to create SbxContext.");
      }
      std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);

      SbxCurveSourceConfig source_cfg{};
      sbx_default_curve_source_config(&source_cfg);
      source_cfg.mode = parsed.is_isochronic
                            ? SBX_TONE_ISOCHRONIC
                            : (parsed.is_monaural ? SBX_TONE_MONAURAL
                                                  : SBX_TONE_BINAURAL);
      source_cfg.waveform = SBX_WAVE_SINE;
      source_cfg.amplitude = 1.0;
      source_cfg.duration_sec = static_cast<double>(main_sec + wake_sec) + 10.0;

      status =
          sbx_context_load_curve_program(next_ctx.get(), curve.get(), &source_cfg);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        return build_context_state_json_locked(
            status,
            error && error[0] ? error
                              : "Failed to load the exact curve runtime.");
      }
      curve.release();

      status = sbx_context_configure_runtime(
          next_ctx.get(), nullptr, 0U, 100.0, nullptr, 0U, nullptr, 0U);
      if (status != SBX_OK) {
        const char *error = sbx_context_last_error(next_ctx.get());
        return build_context_state_json_locked(
            status,
            error && error[0]
                ? error
                : "Failed to configure the exact curve runtime.");
      }

      return adopt_context_locked(std::move(next_ctx),
                                  source_cfg.duration_sec,
                                  request.mix_path,
                                  mix_source_name,
                                  mix_looping,
                                  mix_samples,
                                  mix_sample_count);
    }

    SbxCurveTimeline timeline{};
    SbxCurveTimelineConfig timeline_cfg{};
    sbx_default_curve_timeline_config(&timeline_cfg);
    fill_program_tone_spec(&timeline_cfg.start_tone,
                           parsed.is_isochronic,
                           parsed.is_monaural,
                           carrier_start_hz,
                           parsed.beat_start_hz,
                           parsed.amp_pct);
    timeline_cfg.sample_span_sec = drop_sec;
    timeline_cfg.main_span_sec = main_sec;
    timeline_cfg.wake_sec = wake_sec;
    timeline_cfg.step_len_sec = parsed.step_len_sec;
    timeline_cfg.slide = 0;
    timeline_cfg.mute_program_tone = parsed.mute_program_tone ? 1 : 0;

    status = sbx_build_curve_timeline(curve.get(), &timeline_cfg, &timeline);
    if (status != SBX_OK) {
      const char *error = sbx_curve_last_error(curve.get());
      return build_context_state_json_locked(
          status,
          error && error[0]
              ? error
              : "Failed to build the stepped curve timeline.");
    }

    SbxRuntimeContextConfig runtime_cfg{};
    sbx_default_runtime_context_config(&runtime_cfg);
    runtime_cfg.engine = config_;
    runtime_cfg.mix_kfs = timeline.mix_frames;
    runtime_cfg.mix_kf_count = timeline.mix_frame_count;
    runtime_cfg.default_mix_amp_pct = 100.0;

    double duration_sec = 0.0;
    SbxContext *raw_ctx = nullptr;
    const int create_status = sbx_runtime_context_create_from_keyframes(
        timeline.program_frames,
        timeline.program_frame_count,
        0,
        &runtime_cfg,
        &duration_sec,
        &raw_ctx);
    std::unique_ptr<SbxContext, ContextDeleter> next_ctx(raw_ctx);
    sbx_free_curve_timeline(&timeline);
    if (create_status != SBX_OK) {
      const char *error = raw_ctx ? sbx_context_last_error(raw_ctx) : nullptr;
      return build_context_state_json_locked(
          create_status,
          error && error[0]
              ? error
              : "Failed to create the stepped curve runtime.");
    }

    return adopt_context_locked(std::move(next_ctx),
                                duration_sec,
                                request.mix_path,
                                mix_source_name,
                                mix_looping,
                                mix_samples,
                                mix_sample_count);
  }

  std::string prepare_sbg_context_impl(const std::string &text,
                                       const std::string &source_name,
                                       const int16_t *mix_samples,
                                       size_t mix_sample_count,
                                       const std::string &mix_source_name,
                                       bool mix_looping,
                                       bool allow_streaming_without_samples) {
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
    if (mix_required && !allow_streaming_without_samples &&
        (!mix_samples || mix_sample_count < 2U)) {
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
    mix_active_ = mix_required;
    if (mix_required) {
      mix_source_name_ = mix_source_name.empty() ? requested_mix_path : mix_source_name;
      mix_looping_ = mix_looping;
      mix_cursor_frame_ = 0U;
      if (mix_samples && mix_sample_count > 0U) {
        mix_samples_.assign(mix_samples, mix_samples + mix_sample_count);
      }
    }

    return build_context_state_json_locked(SBX_OK, "");
  }

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
         << "\"mixActive\":" << (mix_active_ ? "true" : "false") << ','
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
         << "\"mixActive\":" << (mix_active_ ? "true" : "false") << ','
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
    mix_active_ = false;
    mix_looping_ = false;
  }

  int apply_stored_mix_stream_locked(float *io,
                                     size_t frames,
                                     double start_time_sec) {
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

  int apply_supplied_mix_stream_locked(float *io,
                                       size_t frames,
                                       double start_time_sec,
                                       const int16_t *mix_samples,
                                       size_t mix_frame_count) {
    if (!context_ || !io || !mix_samples || mix_frame_count == 0U) {
      return SBX_OK;
    }

    const double sample_rate = config_.sample_rate;
    if (!(std::isfinite(sample_rate) && sample_rate > 0.0)) {
      return SBX_ENOTREADY;
    }

    const size_t channels = static_cast<size_t>(config_.channels);
    if (channels != 2U) {
      return SBX_EINVAL;
    }

    const size_t frames_to_mix = std::min(frames, mix_frame_count);
    for (size_t frame = 0; frame < frames_to_mix; ++frame) {
      double mix_add_l = 0.0;
      double mix_add_r = 0.0;
      const size_t sample_index = frame * 2U;
      const size_t mix_index = frame * 2U;
      const int status = sbx_context_mix_stream_sample(
          context_.get(),
          start_time_sec + static_cast<double>(frame) / sample_rate,
          static_cast<int>(mix_samples[mix_index]),
          static_cast<int>(mix_samples[mix_index + 1U]),
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
    }

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
  bool mix_active_ = false;
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

bool make_program_request(const std::string &program_kind,
                          const std::string &main_arg,
                          int drop_time_sec,
                          int hold_time_sec,
                          int wake_time_sec,
                          const std::string &curve_text,
                          const std::string &source_name,
                          const std::string &mix_path,
                          ProgramRequest *out,
                          std::string *error_out) {
  if (!out) {
    if (error_out) {
      *error_out = "Internal program request error.";
    }
    return false;
  }

  ProgramKind kind = ProgramKind::kDrop;
  if (!parse_program_kind(program_kind, &kind)) {
    if (error_out) {
      *error_out = "Unknown built-in program selection.";
    }
    return false;
  }

  ProgramRequest request;
  request.kind = kind;
  request.main_arg = main_arg;
  request.drop_time_sec = drop_time_sec;
  request.hold_time_sec = hold_time_sec;
  request.wake_time_sec = wake_time_sec;
  request.curve_text = curve_text;
  request.source_name =
      source_name.empty() ? program_default_source_name(kind) : source_name;
  request.mix_path = mix_path;
  *out = std::move(request);
  return true;
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
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativePrepareSbgContextStreaming(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jstring source_name,
    jstring mix_source_name,
    jboolean mix_looping) {
  return to_jstring(
      env,
      runtime_state().prepare_sbg_context_streaming(
          jstring_to_utf8(env, text),
          jstring_to_utf8(env, source_name),
          jstring_to_utf8(env, mix_source_name),
          mix_looping == JNI_TRUE));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativePrepareProgramContext(
    JNIEnv *env,
    jobject /* this */,
    jstring program_kind,
    jstring main_arg,
    jint drop_time_sec,
    jint hold_time_sec,
    jint wake_time_sec,
    jstring curve_text,
    jstring source_name,
    jstring mix_path,
    jshortArray mix_samples,
    jstring mix_source_name,
    jboolean mix_looping) {
  ProgramRequest request;
  std::string request_error;
  if (!make_program_request(jstring_to_utf8(env, program_kind),
                            jstring_to_utf8(env, main_arg),
                            static_cast<int>(drop_time_sec),
                            static_cast<int>(hold_time_sec),
                            static_cast<int>(wake_time_sec),
                            jstring_to_utf8(env, curve_text),
                            jstring_to_utf8(env, source_name),
                            jstring_to_utf8(env, mix_path),
                            &request,
                            &request_error)) {
    return to_jstring(env,
                      build_sbg_runtime_config_json(
                          SBX_EINVAL,
                          jstring_to_utf8(env, source_name),
                          44100.0,
                          jstring_to_utf8(env, mix_path),
                          request_error));
  }

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
                    runtime_state().prepare_program_context(
                        request,
                        mix_copy.empty() ? nullptr : mix_copy.data(),
                        mix_copy.size(),
                        jstring_to_utf8(env, mix_source_name),
                        mix_looping == JNI_TRUE));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativePrepareProgramContextStreaming(
    JNIEnv *env,
    jobject /* this */,
    jstring program_kind,
    jstring main_arg,
    jint drop_time_sec,
    jint hold_time_sec,
    jint wake_time_sec,
    jstring curve_text,
    jstring source_name,
    jstring mix_path,
    jstring mix_source_name,
    jboolean mix_looping) {
  ProgramRequest request;
  std::string request_error;
  const std::string safe_source_name = jstring_to_utf8(env, source_name);
  const std::string safe_mix_path = jstring_to_utf8(env, mix_path);
  if (!make_program_request(jstring_to_utf8(env, program_kind),
                            jstring_to_utf8(env, main_arg),
                            static_cast<int>(drop_time_sec),
                            static_cast<int>(hold_time_sec),
                            static_cast<int>(wake_time_sec),
                            jstring_to_utf8(env, curve_text),
                            safe_source_name,
                            safe_mix_path,
                            &request,
                            &request_error)) {
    return to_jstring(
        env,
        build_sbg_runtime_config_json(SBX_EINVAL,
                                      safe_source_name,
                                      44100.0,
                                      safe_mix_path,
                                      request_error));
  }

  return to_jstring(
      env,
      runtime_state().prepare_program_context_streaming(
          request,
          jstring_to_utf8(env, mix_source_name),
          mix_looping == JNI_TRUE));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeParseMixLooperSpec(
    JNIEnv *env,
    jobject /* this */,
    jstring looper_spec,
    jint sample_rate,
    jint total_frames,
    jint mix_section) {
  MixLooperPlanSpec plan;
  std::string error;
  const bool ok = parse_mix_looper_plan(jstring_to_utf8(env, looper_spec),
                                        static_cast<int>(sample_rate),
                                        static_cast<int>(total_frames),
                                        static_cast<int>(mix_section),
                                        &plan,
                                        &error);
  return to_jstring(env,
                    build_mix_looper_plan_json(
                        ok ? SBX_OK : SBX_EINVAL,
                        ok ? &plan : nullptr,
                        error));
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

extern "C" JNIEXPORT jint JNICALL
Java_com_sbagenxandroid_sbagenx_SbagenxBridge_nativeRenderIntoBufferWithMix(
    JNIEnv *env,
    jobject /* this */,
    jfloatArray buffer,
    jint frame_count,
    jshortArray mix_samples,
    jint mix_frame_count) {
  if (!buffer || frame_count <= 0) {
    return SBX_EINVAL;
  }

  const jsize sample_capacity = env->GetArrayLength(buffer);
  jfloat *out = env->GetFloatArrayElements(buffer, nullptr);
  if (!out) {
    return SBX_ENOMEM;
  }

  std::vector<int16_t> mix_copy;
  if (mix_samples && mix_frame_count > 0) {
    const jsize available_samples = env->GetArrayLength(mix_samples);
    const jsize requested_samples = mix_frame_count * 2;
    const jsize sample_count = std::min(available_samples, requested_samples);
    if (sample_count > 0) {
      mix_copy.resize(static_cast<size_t>(sample_count));
      env->GetShortArrayRegion(mix_samples,
                               0,
                               sample_count,
                               reinterpret_cast<jshort *>(mix_copy.data()));
    }
  }

  const int status = runtime_state().render_into_buffer_with_mix(
      out,
      static_cast<size_t>(frame_count),
      static_cast<size_t>(sample_capacity),
      mix_copy.empty() ? nullptr : mix_copy.data(),
      mix_copy.size() / static_cast<size_t>(2));
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
