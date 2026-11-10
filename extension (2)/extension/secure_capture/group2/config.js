// Group 2 settings. Every rule can be tuned here without touching logic.
// All sizes marked "x h" are multiples of the label's text height in pixels,
// so the rules work the same at dpr 1, 2 or 3.

export const CONFIG = {
  ocr: {
    language: 'eng',
    // PSM 11 = "sparse text". Best for screenshots: sidebars, buttons and
    // form fields become separate lines instead of being merged.
    pageSegMode: '11',
    // Upscale small screenshots before OCR (boxes are scaled back after).
    // 'auto' = 2x when dpr < 1.5 and the image is not huge.
    upscale: 'auto',
    maxUpscaledWidth: 4000,
    timeoutMs: 60000,
    // Parallel OCR: number of Tesseract workers (each handles ONE image at a
    // time, so a worker is never given two images). 'auto' = 2 on machines with
    // 4+ CPU cores, else 1. Each worker needs roughly 100-200 MB of memory.
    workers: 'auto',
  },

  ml: {
    modelUrl: new URL('./model/sensitive_model.json', import.meta.url).href,
    wordThreshold: 0.85,   // one OCR word
    lineThreshold: 0.9,    // a whole OCR line
    lineWordThreshold: 0.5, // word inside a line that scored above lineThreshold
    minChars: 4,           // skip very short words ("to", "OK")
    // Pure numbers are handled by regex (phone, CNIC, card). The ML model
    // is not used on them, so counts and prices are never masked by ML.
    skipPureNumbers: true,
    // Fail closed: if the model cannot be loaded, the frame fails.
    required: true,
  },

  // Keyword labels. "terms" are compared after removing everything that is
  // not a letter or digit, so "API_KEY:", "api-key" and "Api Key" all match "apikey".
  // secret: true  -> any value next to the label is masked, and if no value
  //                  is readable (e.g. ******** or dots), the likely input
  //                  field area is masked anyway (fail closed).
  // secret: false -> the value is masked only if it looks like data
  //                  (has a digit or @, or the ML model agrees).
  keywords: [
    { type: 'password', secret: true, terms: ['password', 'passwd', 'passcode', 'pwd', 'confirmpassword', 'newpassword', 'currentpassword', 'oldpassword',
      'passphrase', 'masterpassword', 'repeatpassword', 'retypepassword', 'reenterpassword', 'verifypassword', 'loginpassword', 'userpassword', 'adminpassword', 'wifipassword'] },
    // Short numeric secrets: the value is masked when it has digits (secret: false
    // avoids masking an empty area next to a "Pin" button or menu item).
    { type: 'password', secret: false, terms: ['pin', 'pinno', 'pinnumber', 'otp', 'otpcode', 'onetimepassword', 'onetimecode', 'verificationcode', 'authcode', 'authenticationcode', 'mfacode', '2facode', 'backupcode', 'recoverycode'] },
    { type: 'api_key', secret: true, terms: ['apikey', 'secret', 'secretkey', 'clientsecret', 'token', 'accesstoken', 'authtoken', 'refreshtoken', 'privatekey', 'accesskey', 'authorization', 'bearer',
      'apisecret', 'apitoken', 'appsecret', 'accesskeyid', 'secretaccesskey', 'sessiontoken', 'idtoken', 'webhooksecret', 'signingsecret', 'signingkey', 'encryptionkey', 'connectionstring', 'consumersecret', 'accountkey', 'personalaccesstoken'] },
    { type: 'credit_card', secret: true, terms: ['creditcard', 'cardnumber', 'cardno', 'cvv', 'cvc', 'debitcard',
      'creditcardnumber', 'debitcardnumber', 'cardnum', 'ccnumber', 'cvv2', 'cvc2', 'securitycode', 'cardsecuritycode', 'cardverificationcode'] },
    { type: 'credit_card', secret: false, terms: ['expirydate', 'expdate', 'expirationdate', 'validthru', 'cardexpiry', 'cardexpirydate'] },
    { type: 'cnic', secret: false, terms: ['cnic', 'cnicno', 'cnicnumber', 'nationalid', 'nic'] },
    // International identity documents (contextual: value must look like data)
    { type: 'passport', secret: false, terms: ['passport', 'passportno', 'passportnumber', 'passportnum', 'passportid', 'traveldocument', 'traveldocumentnumber', 'visanumber', 'visano'] },
    { type: 'national_id', secret: false, terms: ['ssn', 'socialsecurity', 'socialsecuritynumber', 'socialsecurityno', 'sinnumber', 'socialinsurancenumber',
      'nino', 'nationalinsurance', 'nationalinsurancenumber', 'aadhaar', 'aadhaarno', 'aadhaarnumber', 'aadhar', 'panno', 'pannumber',
      'taxid', 'taxidnumber', 'tinnumber', 'ein', 'itin', 'vatnumber', 'vatid', 'nationalidnumber', 'nationalidno', 'idnumber', 'idno', 'idcardnumber',
      'identitynumber', 'identitycard', 'personalnumber', 'personalid', 'emiratesid', 'iqama', 'iqamanumber', 'nric', 'dni', 'nie', 'nif', 'bsn', 'curp', 'cpf',
      'driverslicense', 'driverslicence', 'drivinglicense', 'drivinglicence', 'licensenumber', 'licencenumber', 'dlnumber'] },
    { type: 'bank_account', secret: false, terms: ['accountnumber', 'accountno', 'acctno', 'acctnumber', 'bankaccount', 'bankaccountnumber', 'bankaccountno',
      'routingnumber', 'routingno', 'abanumber', 'sortcode', 'swift', 'swiftcode', 'bic', 'biccode', 'swiftbic', 'ifsc', 'ifsccode', 'bsb', 'bsbnumber', 'transitnumber', 'institutionnumber'] },
    { type: 'iban', secret: false, terms: ['iban', 'ibanno', 'ibannumber'] },
    { type: 'date_of_birth', secret: false, terms: ['dob', 'dateofbirth', 'birthdate', 'birthday'] },
    { type: 'email', secret: false, terms: ['email', 'emailaddress', 'emailid', 'workemail', 'personalemail', 'contactemail', 'recoveryemail', 'billingemail'] },
    { type: 'phone', secret: false, terms: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'cell', 'tel', 'telephone', 'whatsapp',
      'cellphone', 'mobilephone', 'homephone', 'workphone', 'contactnumber', 'contactno', 'landline', 'fax', 'faxnumber'] },
  ],
  maxKeywordWords: 3, // "Confirm new password" = 3 words

  spatial: {
    sameRowTolerance: 0.6,  // x h: vertical centre difference for "same row"
    rightMaxGap: 14,        // x h: max gap from label to first value word on the right
    valueWordGap: 3,        // x h: max gap between words of the same value
    maxValueWords: 6,
    belowMaxDistance: 3,    // x h: max distance from label bottom to value top
    belowIndent: 1.5,       // x h: value may start this far left of the label
    // Field area masked for secret labels (password, key, card)
    fieldPadX: 0.6,         // x h
    fieldPadY: 0.6,         // x h
    fieldMinWidth: 12,      // x h
    estimatedFieldWidth: 14,// x h, used when no value text is readable
    estimatedFieldHeight: 2.2,
  },

  redaction: {
    color: '#000000',
    padMin: 2,        // px
    padFactor: 0.15,  // x box height
    outputType: 'image/png',
    // Click highlight drawn again after masking (recorded sessions only).
    clickMarker: { enabled: true, radius: 18, lineWidth: 3, color: '#ff3b30', fill: 'rgba(255, 59, 48, 0.18)' },
  },

  recorder: {
    maxQueuedFrames: 15,      // backpressure: frames waiting for OCR
    retryAfterMs: 1500,       // suggested wait when the queue is full
    nearClickRadius: 260,     // px (image), words used as "text near the click"
    nearClickMaxWords: 14,
    maxOcrCharsPerStep: 1500, // scrubbed text kept for the LLM per step
  },

  output: {
    // Replace the text of masked words in ocrText with "[REDACTED:type]",
    // so PII does not leak into storage through the OCR text.
    maskSensitiveOcrText: true,
  },

  // Type priority when two regions overlap (lower index wins).
  typePriority: ['password', 'api_key', 'credit_card', 'cnic', 'passport', 'national_id', 'iban', 'bank_account', 'email', 'phone', 'date_of_birth', 'sensitive_text'],
};
