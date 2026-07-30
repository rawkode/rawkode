import AVFoundation

public enum AssistantSpeechUtteranceFactory {
  public static func makeUtterances(
    for text: String,
    voice: AVSpeechSynthesisVoice
  ) -> [AVSpeechUtterance] {
    AssistantSpeechPacingPlan(text: text, languageIdentifier: voice.language)
      .segments
      .map { segment in
        let utterance = AVSpeechUtterance(string: segment.text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1
        utterance.postUtteranceDelay = segment.postUtteranceDelay
        return utterance
      }
  }
}
