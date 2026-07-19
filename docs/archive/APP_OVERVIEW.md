# Telangana Sale Deed Registration Application - Overview

## 🎯 Application Purpose
This is a **Telangana Sale Deed Wizard & Registry** application - a comprehensive 9-step workflow tool for property registration documents in Telangana, India.

## 🚀 Currently Running
✅ **Server Status**: Running on **http://localhost:3000**
✅ **Dependencies**: Installed
✅ **Framework**: React + Vite + Express

## 📋 Key Features

### 1. **9-Step Wizard Workflow**
The application guides users through a complete sale deed registration process:

1. **Property Verification Metadata** - Enter property details (district, mandal, village, survey numbers, boundaries)
2. **Executant & Claimant Identity** - Seller and buyer information with Aadhaar and PAN details
3. **Property Registration Details** - Bilingual form with market value, stamp duty, nature of transaction
4. **Document Upload** - Upload Aadhaar cards and link documents
5. **AI Extraction** - AI-powered extraction of details from uploaded documents
6. **Model Template Selection** - Choose from predefined deed templates
7. **Auto-fill Deed Document** - Generate bilingual sale deed
8. **AI Audit & Verification** - Automated verification using Gemini AI
9. **Final Review & Registry** - Save, print, or download the final deed

### 2. **Bilingual Support**
- Supports both English and Telugu (తెలుగు)
- All official forms and documents are bilingual
- Follows Telangana Stamps Act requirements

### 3. **Pre-loaded Scenarios**
The app includes test cases/presets for:
- Standard residential plot sales
- Agricultural land transfers
- Apartment/flat registrations
- Gift deeds
- And more...

### 4. **AI-Powered Features**
- **Document Extraction**: Uses Google Gemini AI to extract information from uploaded documents
- **Verification & Audit**: Automated compliance checking
- **Template Auto-fill**: Intelligent form filling based on extracted data

### 5. **Document Management**
- Save drafts to local registry
- Print with proper stamp paper styling
- Download as .txt or .doc format
- Copy to clipboard
- Offline storage using localStorage

## 🎨 Design Features

### Visual Theme
- **Primary Color**: Teal/Green (#0a4d4a) - reminiscent of official Telangana government documents
- **Background**: Off-white (#faf9f6) - resembles stamp paper
- **Clean, Official Look**: Designed to look like actual registration documents

### UI Components
- Step-by-step progress indicator
- Animated transitions using Framer Motion
- Icons from Lucide React
- Responsive design with Tailwind CSS
- Professional form layouts

## 📦 Technology Stack

```json
{
  "Frontend": "React 19 + TypeScript",
  "Styling": "Tailwind CSS 4",
  "Build Tool": "Vite 6",
  "Backend": "Express.js",
  "AI": "Google Gemini API (@google/genai)",
  "Animations": "Motion (Framer Motion)",
  "Icons": "Lucide React",
  "Document Processing": "Mammoth.js (Word docs)"
}
```

## 🔑 Configuration Needed

The app requires a **Gemini API key** to function fully. Currently set in `.env.local`:
```
GEMINI_API_KEY=your_api_key_here
```

To get full AI features working, replace with an actual Google AI Studio API key from:
https://ai.google.dev/

## 🌐 How to View

### Open in Browser
Simply open your browser and navigate to:
```
http://localhost:3000
```

### What You'll See
1. **Header**: Telangana Sale Deed Wizard branding with date selector
2. **Scenario Presets Button**: Click to see pre-loaded test cases
3. **Step Progress Bar**: Shows current step in the 9-step workflow
4. **Main Form Area**: Interactive forms for data entry
5. **Navigation Buttons**: Previous/Next step controls

## 📊 Sample Data Pre-loaded

The app comes with sample data for testing:
- **Property**: Nalgonda District, Nakrekal Mandal, Survey No. 412/A
- **Seller**: Ankem Srinivas (with Aadhaar and PAN)
- **Buyer**: Ganta Venkat Reddy
- **Market Value**: ₹24,00,000
- **Stamp Duty**: ₹1,44,000

## 🔄 Workflow Example

```
Start → Enter Property Details → Enter Parties Info → 
Upload Documents → AI Extracts Data → Select Template → 
Auto-fill Deed → AI Verifies → Review & Save/Print
```

## 📝 Use Cases

1. **Sub-Registrar Offices**: Streamline property registration
2. **Real Estate Agents**: Generate professional sale deeds
3. **Legal Practitioners**: Create compliant property documents
4. **Property Owners**: Self-service deed preparation
5. **Training**: Practice scenarios for registration staff

## 🎯 Next Steps to Try

1. **Open** http://localhost:3000 in your browser
2. **Click** "Scenario Presets" to see test cases
3. **Navigate** through the 9 steps using Next/Previous buttons
4. **Explore** different property types (residential, agricultural, apartment)
5. **Try** the AI features (requires API key setup)

## 📸 Key Screens to Explore

- **Step 1**: Property verification form with boundaries
- **Step 2**: Executant/Claimant identity forms
- **Step 3**: Bilingual registration details
- **Step 7**: Auto-generated sale deed preview
- **Step 8**: AI audit report with compliance checks
- **Step 9**: Final document with print/download options

---

**Status**: ✅ Application is ready to use!
**URL**: http://localhost:3000
**Port**: 3000
