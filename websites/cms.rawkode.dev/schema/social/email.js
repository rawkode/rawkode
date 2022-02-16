import React from "react";
import { TextInput, Stack, Label } from "@sanity/ui";
import { MdEmail } from "react-icons/md";
import { FormField } from "@sanity/base/components";
import PatchEvent, { set, unset } from "@sanity/form-builder/PatchEvent";
import { useId } from "@reach/auto-id";

export const EmailAddress = {
  name: "email",
  title: "Email Address",
  type: "email",
  inputComponent: React.forwardRef((props, ref) => {
    const {
      type, // Schema information
      value, // Current field value
      readOnly, // Boolean if field is not editable
      placeholder, // Placeholder text from the schema
      markers, // Markers including validation rules
      presence, // Presence information for collaborative avatars
      compareValue, // Value to check for "edited" functionality
      onFocus, // Method to handle focus state
      onBlur, // Method to handle blur state
      onChange, // Method to handle patch events
    } = props;

    // Creates a unique ID for our input
    const inputId = useId();

    // Creates a change handler for patching data
    const handleChange = React.useCallback(
      // useCallback will help with performance
      (event) => {
        const inputValue = event.currentTarget.value; // get current value
        // if the value exists, set the data, if not, unset the data
        onChange(PatchEvent.from(inputValue ? set(inputValue) : unset()));
      },
      [onChange]
    );

    return (
      <FormField
        description={type.description} // Creates description from schema
        title={type.title} // Creates label from schema title
        __unstable_markers={markers} // Handles all markers including validation
        __unstable_presence={presence} // Handles presence avatars
        compareValue={compareValue} // Handles "edited" status
        inputId={inputId} // Allows the label to connect to the input field
      >
        <Stack space={2}>
          <TextInput
            id={inputId}
            onFocus={onFocus}
            onBlur={onBlur}
            readOnly={readOnly}
            placeholder={placeholder}
            onChange={handleChange}
            ref={ref}
            value={value}
            icon={MdEmail}
          />
        </Stack>
      </FormField>
    );
  }),
};
